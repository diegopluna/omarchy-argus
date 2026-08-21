#!/usr/bin/env bash
# Emit a scrubbed full sample of THIS machine for the fixture corpus:
#
#   bash tests/make-fixture.sh > tests/fixtures/<cpu>-<gpu>.txt
#
# Fixtures teach the parser about hardware the maintainers don't own —
# every fixture is parsed by tests/model.test.js on every CI run, so a
# weird hwmon layout only has to break Argus once.
#
# Scrubbing: the hostname is replaced and process lists (PSCPU/PSMEM/
# GPUPROC) are dropped — command lines can carry private paths and URLs.
# Everything else (chip names, drive models, sensor labels) is exactly
# what makes a fixture useful. Review the output before contributing it.

cd "$(dirname "$0")/.." || exit 1
bash sample.sh | awk '
  /^###/ { section = substr($0, 4) }
  section == "HOST" && !/^###/ { print "fixture-host"; next }
  (section == "PSCPU" || section == "PSMEM" || section == "GPUPROC") && !/^###/ { next }
  { print }
'
