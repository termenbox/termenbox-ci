#!/bin/bash
# Custom step shell (`defaults.run.shell: quiet {0}`). Runs the step script the way a step without `shell:` does (bash -e, no pipefail), sends
# every byte of its output to an encrypted-later log file and prints only the exit code, so the public log never
# carries source, paths, test names or compiler output.
log="${RUNNER_TEMP:-/tmp}/quiet.log"
bash --noprofile --norc -e "$1" >>"$log" 2>&1
rc=$?
echo "step finished: exit $rc"
exit $rc
