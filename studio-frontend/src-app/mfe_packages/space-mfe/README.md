# space-mfe

The editor screen: a frame package (ADR-0021) at the project level,
`placement: hidden`, `presentation.route: '/space'`. The shell mounts it when
the address names `screen=space` — opening an artifact is a navigation (#320).

The frame loads the address in `…space.mfe.frame_url.v1~`. Until the session
gate exists (#322) that is this package's own static page, seeded by the shell
from the generated catalogue. The artifact reaches the frame in #323; the frame
never reads the portal's address.
