---
name: bash-standards
category: coding
description: >-
  Enforce enterprise-grade bash scripting best practices including main function
  patterns, argument parsing, error handling, dependency validation, and colored
  output. Use when creating or reviewing bash/shell scripts for production use.
keywords: [bash, shell, script, best-practices, error-handling, getopts, template]
allowedTools: [fs_read_file, coding_write_file_tracked, shell_execute]
minComplexity: simple
recommendedTier: fast
estimatedTokens: 1250
outputFormat: patch
tags: [coding, bash, shell, standards]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Bash Standards

> Adapted from [bentsolheim/claude-skill-bash](https://github.com/bentsolheim/claude-skill-bash) (MIT).

## Trigger
Agent is creating or reviewing bash/shell scripts and needs to enforce
production-grade best practices.

## Script Complexity Decision

**Simple scripts** (<30 lines, no arguments, single purpose):
- No `main()` wrapper needed
- Clear purpose comment at top
- Proper exit codes and stderr for errors

**Ordinary scripts** (>30 lines OR takes arguments OR complex branching):
- Full structure required (see below)

## Procedure

### Step 1: Determine script type

Ask:
1. Does it take arguments? → Ordinary
2. Is logic >30 lines? → Ordinary
3. Multiple functions or complex branching? → Ordinary
4. Interactive (run by humans who need help)? → Ordinary
5. Single, self-evident task? → Simple

**When in doubt → Ordinary.**

### Step 2: Apply ordinary script template

```bash
#!/usr/bin/env bash

# Global declarations
DEPENDENCIES=(jq curl git)
SCRIPT_NAME=$(basename "$0")
VERSION="1.0.0"

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Respect NO_COLOR environment
if [[ -n "${NO_COLOR:-}" ]] || [[ "${TERM:-}" == "dumb" ]]; then
    RED="" GREEN="" YELLOW="" BLUE="" NC=""
fi

function usage() {
    cat <<EOM

Brief description of what this script does.

usage: ${SCRIPT_NAME} [options]

options:
    -i|--input   <file>   Input file (required)
    -o|--output  <file>   Output file (optional)
    -v|--verbose          Enable verbose output
    -h|--help             Show this help message
    --version             Show version

dependencies: ${DEPENDENCIES[@]}

examples:
    ${SCRIPT_NAME} -i data.txt -o report.json
EOM
    exit 1
}

function main() {
    local input_file="" output_file="" verbose=false

    while [ "$1" != "" ]; do
        case $1 in
        -i | --input)  shift; input_file="$1" ;;
        -o | --output) shift; output_file="$1" ;;
        -v | --verbose) verbose=true ;;
        --version) echo "${SCRIPT_NAME} version ${VERSION}"; exit 0 ;;
        -h | --help) usage ;;
        *) echo "Error: Unknown option '$1'"; usage ;;
        esac
        shift
    done

    if [ -z "$input_file" ]; then
        echo "Error: Input file is required" >&2
        usage
    fi

    exit_on_missing_tools "${DEPENDENCIES[@]}"
    process_file "$input_file" "$output_file" "$verbose"
}

# Business logic functions here
function process_file() {
    local input="$1" output="$2" verbose="$3"
    echo "Processing ${input}..."
}

# Utility functions
function exit_on_missing_tools() {
    for cmd in "$@"; do
        if command -v "$cmd" &>/dev/null; then continue; fi
        printf "Error: Required tool '%s' is not installed\n" "$cmd"
        exit 1
    done
}

# Guard clause — only execute main if run directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
    exit 0
fi
```

### Step 3: Error handling rules

**NEVER use `set -e`.** Handle errors explicitly:

```bash
# Good — explicit check
if ! command; then
    echo "Error: Command failed" >&2
    exit 1
fi

# Good — chain with ||
cd /some/dir || { echo "Error: Cannot cd" >&2; exit 1; }

# Good — capture and check
output=$(command 2>&1)
if [ $? -ne 0 ]; then
    echo "Error: $output" >&2
    exit 1
fi
```

**Pipeline errors:**
```bash
command1 | command2
if [ "${PIPESTATUS[0]}" -ne 0 ]; then
    echo "Error: command1 failed" >&2
    exit 1
fi
```

### Step 4: Function organization (mandatory order)

1. `usage()` — first after globals
2. `main()` — immediately after usage
3. Business logic functions — core functionality
4. Utility functions — generic helpers

**Do NOT** add section comment headers like `# UTILITY FUNCTIONS`.

### Step 5: Variable and output rules

- **Always declare local:** `local var="value"` inside functions
- **Always quote variables:** `"$var"` not `$var`
- **Errors to stderr:** `echo "Error: ..." >&2`
- **Temp files with cleanup:** `trap "rm -f '$tmp'" EXIT`

**Output helpers:**
```bash
function print_success() { echo -e "${GREEN}✅ $1${NC}"; }
function print_error()   { echo -e "${RED}❌ Error: $1${NC}" >&2; }
function print_warning() { echo -e "${YELLOW}⚠️  Warning: $1${NC}"; }
function print_step()    { echo -e "${YELLOW}[$1/$2] $3${NC}"; }
```

### Step 6: Verification checklist

Before finalizing any script, verify:
- [ ] Shebang: `#!/usr/bin/env bash`
- [ ] DEPENDENCIES declared
- [ ] `usage()` defined (if ordinary)
- [ ] `main()` with argument parsing (if ordinary)
- [ ] Dependency check with `exit_on_missing_tools`
- [ ] Guard clause at end (if ordinary)
- [ ] No `set -e` anywhere
- [ ] Functions properly ordered
- [ ] Local variables in functions
- [ ] Errors to stderr
- [ ] Meaningful exit codes
- [ ] Syntax check: `bash -n script.sh`

## Success criteria
- Script follows the correct template (simple or ordinary)
- `bash -n script.sh` passes (no syntax errors)
- Error paths exit with non-zero and write to stderr
- Dependencies explicitly checked before use
- Guard clause enables safe sourcing
