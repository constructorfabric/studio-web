#!/bin/sh
# Backend container entrypoint: grant access to the mounted Docker socket,
# then drop to the unprivileged `studio` user.
#
# Why this exists: the studio-session gear launches sibling Theia containers
# through the host daemon, so /var/run/docker.sock is bind-mounted in. That
# socket is 0660 root:<docker-group>, and the group id differs per host —
# 999 on a stock Debian, 0 under Docker Desktop's VM, the invoking user's own
# gid under rootless Docker. Baking a gid into the image would work on exactly
# one machine, and `USER studio` alone earns a bare
# "Permission denied (os error 13)" on every daemon call.
#
# So the gid is discovered at start and the user joined to whatever group owns
# the socket. The socket's own ownership is deliberately NOT touched: it is a
# host file, and chowning it would change permissions outside this container.
set -e

SOCK=/var/run/docker.sock
if [ -S "$SOCK" ]; then
    sock_gid=$(stat -c %g "$SOCK")
    group=$(getent group "$sock_gid" | cut -d: -f1)
    if [ -z "$group" ]; then
        group=dockerhost
        groupadd -g "$sock_gid" "$group"
    fi
    # gid 0 lands here too: `studio` joins the root GROUP (not the root user),
    # which is enough to read a 0660 root:root socket and nothing more.
    usermod -aG "$group" studio
else
    echo "backend: $SOCK not mounted — IDE sessions will be unavailable" >&2
fi

# Workspace files are created by the backend and handed to session containers
# as host paths. Docker creates the bind-mount source root-owned, so without
# this the first session launch fails on mkdir.
#
# The recursive branch is a one-time migration: workspaces created before the
# server user was pinned to uid 1000 belong to a `--system` uid the Theia
# container (running as node, uid 1000) cannot write to, which surfaces as
# "could not create leading directories … Permission denied" halfway through
# cloning. Once the root is owned correctly this costs a single stat.
WORKSPACES_ROOT="${STUDIO_WORKSPACES_ROOT:-/srv/cf-studio-workspaces}"
if [ -d "$WORKSPACES_ROOT" ]; then
    want=$(id -u studio)
    if [ "$(stat -c %u "$WORKSPACES_ROOT")" = "$want" ]; then
        chown studio:studio "$WORKSPACES_ROOT" 2>/dev/null || true
    else
        echo "backend: re-owning $WORKSPACES_ROOT to uid $want (one-time)" >&2
        chown -R studio:studio "$WORKSPACES_ROOT" 2>/dev/null || true
    fi
fi

# Artifact-ingest clone volume. Mounted root-owned like the workspaces root, so
# make it writable for the server user or the gear can't create checkouts in it.
ARTIFACT_WORKDIR="${STUDIO_ARTIFACT_WORKDIR:-}"
if [ -n "$ARTIFACT_WORKDIR" ]; then
    mkdir -p "$ARTIFACT_WORKDIR" 2>/dev/null || true
    chown studio:studio "$ARTIFACT_WORKDIR" 2>/dev/null || true
fi

exec gosu studio /app/studio-backend "$@"
