#!/usr/bin/env bash
# Emit a scrubbed full sample of THIS machine for the fixture corpus:
#
#   bash tests/make-fixture.sh > tests/fixtures/<cpu>-<gpu>.txt
#
# Fixtures teach the parser about hardware the maintainers don't own —
# every fixture is parsed by tests/model.test.js on every CI run, so a
# weird hwmon layout only has to break Argus once.
#
# Scrubbing: the hostname is replaced, process lists (PS/GPUPROC) are
# dropped — command lines can carry usernames, private paths and URLs —
# and NETINFO is dropped (IP addresses, Wi-Fi SSID). Everything else
# (chip names, drive models, sensor labels) is exactly what makes a
# fixture useful. Review the output before contributing it.

cd "$(dirname "$0")/.." || exit 1
bash sample.sh | awk '
  /^###/ { section = substr($0, 4) }
  section == "HOST" && !/^###/ { print "fixture-host"; next }
  # PS carries usernames and command lines; NETINFO carries IPs and the
  # Wi-Fi SSID. Drop their content, keep the section headers.
  (section == "PS" || section == "PSCPU" || section == "PSMEM" || section == "GPUPROC" || section == "NETINFO") && !/^###/ { next }
  { print }
'
