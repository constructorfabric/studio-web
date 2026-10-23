//! The workflow Studio proposes to a product's repository (ADR-0048 §5).
//!
//! One GitHub Actions workflow builds what the project's environments run:
//! it brings in the Gearbox engine Studio itself runs, the product's gear
//! sources as `product.gdl` names them, generates the `kubernetes` profile,
//! builds and pushes the images, publishes the chart beside them, and
//! uploads `studio-build.json` -- the manifest the sync turns into the run's
//! build, which a deploy then names.
//!
//! Every value put into the YAML is checked here first: a product id, a
//! profile, a registry prefix, a git URL and a revision, each in the shape
//! it has, so none can carry YAML or shell of its own.

use super::model::{Invalid, is_dns_label};

/// Where the workflow of `product` lives in its repository: one per product,
/// since a repository may hold several.
pub fn path(product: &str) -> String {
    format!(".github/workflows/studio-build-{product}.yml")
}

/// What the workflow is made from.
#[derive(Debug, Clone)]
pub struct Params {
    /// The product's description in the repository: `product.gdl`, or
    /// `products/sample/product.gdl`.
    pub product_file: String,
    /// The product's id, the description's `id`: the chart's name.
    pub product: String,
    /// The `kubernetes` profile to generate (`prod`).
    pub profile: String,
    /// `ghcr.io/acme`: where images and the chart go.
    pub prefix: String,
    /// The Gearbox engine's repository and the commit Studio runs.
    pub engine_repo: String,
    pub engine_rev: String,
}

fn bad(field: &'static str, reason: String) -> Invalid {
    Invalid { field, reason }
}

/// `params` checked to be safe to write into the workflow.
pub fn checked(p: &Params) -> Result<(), Invalid> {
    if !is_product_file(&p.product_file) {
        return Err(bad(
            "product_file",
            format!(
                "'{}' is not a product description in the repository (product.gdl, products/shop/product.gdl)",
                p.product_file
            ),
        ));
    }
    if !is_dns_label(&p.product) {
        return Err(bad(
            "product",
            format!("'{}' is not a product id", p.product),
        ));
    }
    if p.profile.is_empty()
        || p.profile.len() > 63
        || !p
            .profile
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(bad(
            "profile",
            format!("'{}' is not a profile id", p.profile),
        ));
    }
    let prefix_ok = !p.prefix.is_empty()
        && p.prefix.contains('/')
        && p.prefix.bytes().all(|b| {
            b.is_ascii_lowercase()
                || b.is_ascii_digit()
                || matches!(b, b'.' | b'-' | b'_' | b'/' | b':')
        });
    if !prefix_ok {
        return Err(bad(
            "registry",
            format!(
                "'{}' is not a registry prefix with a path (ghcr.io/acme): a workflow pushes under one",
                p.prefix
            ),
        ));
    }
    let repo_ok = p.engine_repo.starts_with("https://")
        && p.engine_repo
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'/' | b':'));
    let rev_ok = (7..=40).contains(&p.engine_rev.len())
        && p.engine_rev.bytes().all(|b| b.is_ascii_hexdigit());
    if !repo_ok || !rev_ok {
        return Err(bad(
            "engine",
            "this deployment does not know the Gearbox engine's repository and commit".into(),
        ));
    }
    Ok(())
}

/// A path in the repository to a `.gdl` file: relative, no `..`, plain
/// characters.
pub fn is_product_file(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 200
        && path.ends_with(".gdl")
        && !path.starts_with('/')
        && !path
            .split('/')
            .any(|seg| seg.is_empty() || seg == "." || seg == "..")
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'/'))
}

/// The registry host of a prefix: `ghcr.io` of `ghcr.io/acme`.
fn host(prefix: &str) -> &str {
    prefix.split('/').next().unwrap_or(prefix)
}

/// The workflow's text.
pub fn render(p: &Params) -> Result<String, Invalid> {
    checked(p)?;
    Ok(TEMPLATE
        .replace("@PRODUCT_FILE@", &p.product_file)
        .replace("@PRODUCT@", &p.product)
        .replace("@PROFILE@", &p.profile)
        .replace("@REGISTRY@", host(&p.prefix))
        .replace("@PREFIX@", &p.prefix)
        .replace("@ENGINE_REPO@", &p.engine_repo)
        .replace("@ENGINE_REV@", &p.engine_rev))
}

const TEMPLATE: &str = r#"# Proposed by Constructor Studio (ADR-0048): builds the product's images and
# chart for its environments and tells Studio what it published. Studio deploys
# what this uploads as `studio-build`; change the steps, keep the manifest.
#
# The registry login: GITHUB_TOKEN reaches ghcr.io. For another registry, set
# the repository secrets STUDIO_REGISTRY_USERNAME and STUDIO_REGISTRY_TOKEN.
name: Studio build @PRODUCT@

on:
  workflow_dispatch:
  push:
    branches: [main, master]

permissions:
  contents: read
  packages: write

env:
  PRODUCT_FILE: "@PRODUCT_FILE@"
  PRODUCT: "@PRODUCT@"
  PROFILE: "@PROFILE@"
  REGISTRY: "@REGISTRY@"
  PREFIX: "@PREFIX@"
  GEARBOX_REPO: "@ENGINE_REPO@"
  GEARBOX_REV: "@ENGINE_REV@"

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: The Gearbox engine Studio runs
        id: engine
        uses: actions/cache@v4
        with:
          path: ~/.cargo/bin/gearbox
          key: gearbox-${{ env.GEARBOX_REV }}

      - name: Build the engine
        if: steps.engine.outputs.cache-hit != 'true'
        run: cargo install --locked --git "$GEARBOX_REPO" --rev "$GEARBOX_REV" gearbox-cli

      - name: The product's gear sources
        run: |
          set -eu
          mkdir -p .gearbox-sources
          gearbox product --file "$PRODUCT_FILE" --format json > .gearbox-sources/product.json
          : > .gearbox-sources/roots
          # A path source is relative to the product's description.
          base="$(dirname "$PRODUCT_FILE")"
          # `|`, not a tab: a tab is whitespace to `read`, and the empty url and
          # rev of a path source would collapse into it.
          jq -r '.sources | to_entries[] | [.key, .value.kind, (.value.url // ""), (.value.rev // ""), (.value.at // "")] | join("|")' \
            .gearbox-sources/product.json |
          while IFS='|' read -r id kind url rev at; do
            if [ "$kind" = git ]; then
              git init -q ".gearbox-sources/$id"
              git -C ".gearbox-sources/$id" fetch -q --depth 1 "$url" "$rev"
              git -C ".gearbox-sources/$id" checkout -q FETCH_HEAD
              echo ".gearbox-sources/$id" >> .gearbox-sources/roots
            else
              dir="$(realpath -m --relative-to=. "$base/$at")"
              if [ "$(basename "$dir")" = "$id" ]; then
                echo "$dir" >> .gearbox-sources/roots
              else
                ln -s "../$dir" ".gearbox-sources/$id"
                echo ".gearbox-sources/$id" >> .gearbox-sources/roots
              fi
            fi
          done

      - name: Generate the ${{ env.PROFILE }} profile
        run: |
          set -eu
          set --
          while read -r root; do set -- "$@" --root "$root"; done < .gearbox-sources/roots
          gearbox generate "$@" --product "$PRODUCT_FILE" --profile "$PROFILE" --out .gearbox/out

      - name: Log in to the registry
        env:
          USERNAME: ${{ secrets.STUDIO_REGISTRY_USERNAME || github.actor }}
          TOKEN: ${{ secrets.STUDIO_REGISTRY_TOKEN || secrets.GITHUB_TOKEN }}
        run: |
          echo "$TOKEN" | docker login "$REGISTRY" -u "$USERNAME" --password-stdin
          echo "$TOKEN" | helm registry login "$REGISTRY" -u "$USERNAME" --password-stdin

      - name: Build and push the images
        run: |
          set -eu
          # Two gaps of the generated tree, closed here until the engine does
          # (constructorfabric/gearbox#12):
          # build.sh passes `--ignorefile`, which no docker build takes -- a
          # Dockerfile's own `<Dockerfile>.dockerignore` does the same; and the
          # build stage has no protoc or cmake, which gRPC gears and zlib need.
          for d in .gearbox/out/docker/*/; do
            cp .gearbox/out/docker/.dockerignore "${d}Dockerfile.dockerignore"
            grep -q protobuf-compiler "${d}Dockerfile" ||
              sed -i '/^FROM rust:.* AS build$/a RUN apt-get update -qq \&\& apt-get install -y -qq --no-install-recommends protobuf-compiler libprotobuf-dev cmake \&\& rm -rf /var/lib/apt/lists/*' "${d}Dockerfile"
          done
          sed -i '/--ignorefile/d' .gearbox/out/docker/build.sh
          sh .gearbox/out/docker/build.sh
          short="$(echo "$GITHUB_SHA" | cut -c1-12)"
          echo '[]' > images.json
          sed -n "s/^ *build_one \([A-Za-z0-9_-]*\) '\([^']*\)'.*/\1 \2/p" .gearbox/out/docker/build.sh | sort -u |
          while read -r app image; do
            name="${image%%:*}"
            target="$PREFIX/$name:sha-$short"
            docker tag "$image" "$target"
            docker push "$target"
            digest="$(docker inspect --format '{{index .RepoDigests 0}}' "$target")"
            jq --arg app "$app" --arg image "$target@${digest#*@}" '. + [{app: $app, image: $image}]' images.json > images.next
            mv images.next images.json
          done

      - name: Publish the chart
        run: |
          set -eu
          short="$(echo "$GITHUB_SHA" | cut -c1-12)"
          base="$(sed -n 's/^version: *"\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' ".gearbox/out/helm/$PRODUCT/Chart.yaml" | head -1)"
          version="${base:-0.1.0}-sha.$short"
          helm package ".gearbox/out/helm/$PRODUCT" --version "$version" -d .gearbox/charts
          helm push ".gearbox/charts/$PRODUCT-$version.tgz" "oci://$PREFIX/charts"
          echo "CHART_VERSION=$version" >> "$GITHUB_ENV"

      - name: The manifest Studio reads
        run: |
          set -eu
          lock=""
          if [ -f .gearbox/out/product.lock ]; then lock="$(sha256sum .gearbox/out/product.lock | cut -c1-64)"; fi
          jq -n --arg product "$PRODUCT" --arg profile "$PROFILE" --arg commit "$GITHUB_SHA" \
            --arg lock "$lock" --arg chart "oci://$PREFIX/charts/$PRODUCT" --arg version "$CHART_VERSION" \
            --slurpfile images images.json \
            '{product: $product, profile: $profile, commit: $commit, images: $images[0],
              chart: {reference: $chart, version: $version}}
             + (if $lock == "" then {} else {lock_hash: $lock} end)' > studio-build.json
          cat studio-build.json

      - uses: actions/upload-artifact@v4
        with:
          name: studio-build
          path: studio-build.json
          retention-days: 90
"#;

/// The product's id out of `product.gdl`: the first `id = "…"` inside
/// `product(`.
pub fn product_id(gdl: &str) -> Option<String> {
    let text: String = gdl
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n");
    let at = text.find("product(")?;
    let rest = &text[at..];
    let mut i = 0;
    while let Some(pos) = rest[i..].find("id") {
        let start = i + pos;
        let before_ok = start == 0
            || !rest.as_bytes()[start - 1].is_ascii_alphanumeric()
                && rest.as_bytes()[start - 1] != b'_';
        let after = rest[start + 2..].trim_start();
        if before_ok && let Some(value) = after.strip_prefix('=') {
            let value = value.trim_start();
            if let Some(v) = value.strip_prefix('"') {
                return v.split('"').next().map(str::to_owned);
            }
        }
        i = start + 2;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> Params {
        Params {
            product_file: "products/sample/product.gdl".into(),
            product: "studio-web".into(),
            profile: "prod".into(),
            prefix: "ghcr.io/acme".into(),
            engine_repo: "https://github.com/MikeFalcon77/gearbox.git".into(),
            engine_rev: "6d60603f8db36ef30ee50e1ff7008f3ee24a2501".into(),
        }
    }

    #[test]
    fn the_workflow_publishes_under_the_environments_prefix_with_studios_engine() {
        let y = render(&params()).unwrap();
        assert!(y.contains("PREFIX: \"ghcr.io/acme\""));
        assert!(y.contains("REGISTRY: \"ghcr.io\""));
        assert!(y.contains("GEARBOX_REV: \"6d60603f8db36ef30ee50e1ff7008f3ee24a2501\""));
        assert!(y.contains("name: studio-build"));
        assert!(y.contains("PRODUCT_FILE: \"products/sample/product.gdl\""));
        for placeholder in [
            "@PRODUCT_FILE@",
            "@PRODUCT@",
            "@PROFILE@",
            "@REGISTRY@",
            "@PREFIX@",
            "@ENGINE_REPO@",
            "@ENGINE_REV@",
        ] {
            assert!(!y.contains(placeholder), "{placeholder} left in");
        }
        // The YAML parses.
        let doc: serde_yaml::Value = serde_yaml::from_str(&y).unwrap();
        assert_eq!(doc["env"]["PRODUCT"], "studio-web");
    }

    #[test]
    fn nothing_that_could_carry_yaml_or_shell_is_written() {
        for (field, f) in [
            (
                "product",
                Box::new(|p: &mut Params| p.product = "x\"\n  evil: 1".into())
                    as Box<dyn Fn(&mut Params)>,
            ),
            (
                "profile",
                Box::new(|p: &mut Params| p.profile = "prod; rm -rf /".into()),
            ),
            (
                "registry",
                Box::new(|p: &mut Params| p.prefix = "ghcr.io".into()),
            ),
            (
                "registry",
                Box::new(|p: &mut Params| p.prefix = "ghcr.io/$(id)".into()),
            ),
            (
                "engine",
                Box::new(|p: &mut Params| p.engine_rev = "main".into()),
            ),
        ] {
            let mut p = params();
            f(&mut p);
            assert_eq!(render(&p).unwrap_err().field, field);
        }
    }

    #[test]
    fn a_product_description_is_a_gdl_file_inside_the_repository() {
        assert!(is_product_file("product.gdl"));
        assert!(is_product_file("products/sample/product.gdl"));
        for bad in [
            "/etc/product.gdl",
            "../x.gdl",
            "a/../b.gdl",
            "product.yml",
            "a b.gdl",
            "a//b.gdl",
            "",
        ] {
            assert!(!is_product_file(bad), "{bad}");
        }
        assert_eq!(path("shop"), ".github/workflows/studio-build-shop.yml");
    }

    #[test]
    fn the_product_id_is_read_from_its_description() {
        let gdl = "# product(id = \"no\")\nproduct(\n    id = \"studio-web\",\n    name = \"Studio\",\n    sources = [source(id = \"gears-rust\", at = path(\"x\"))])";
        assert_eq!(product_id(gdl).as_deref(), Some("studio-web"));
        assert_eq!(product_id("nothing here"), None);
    }
}
