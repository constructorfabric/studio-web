# Subscript, superscript, insert

Water is H~2~O. Einstein wrote E = mc^2^. The editor ++inserted this
clause++ during review.

These three forms are recognised by the parser (see md-parse.js's
inline-marks) but have no ProseMirror mark yet — CONTRACT.md's "Marks
being added" list names only `strike` and `highlight` for this wave — so
each one currently falls through md-schema.js's X-01 fallback to
rawInline, verbatim. Adding `subscript`/`superscript`/`insert` rows to the
schema table is a single small change once those marks exist.
