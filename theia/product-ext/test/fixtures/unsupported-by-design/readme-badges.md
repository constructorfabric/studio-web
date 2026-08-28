# Badges

The shape every README opens with, and the one construct this schema cannot
model: an image inside a link. StudioImage is configured `inline: false`, so
`image` is a block node — it can be a paragraph's replacement but never a
paragraph's content, and a block node cannot carry the link mark either. Both
candidate shapes fail ProseMirror's content check, so the source is preserved
verbatim instead.

Making images inline-capable is the fuller answer and is a product decision:
the figure and comment machinery both assume a block image today.

[![Build Status](https://img.shields.io/badge/build-passing-brightgreen)](https://example.com)
