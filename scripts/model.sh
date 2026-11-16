#!/usr/bin/env bash
# ScanList — EmbeddingGemma 2 model provisioning (card S6).
#
#   scripts/model.sh fetch  [--force] [--detach]     download the on-device bundle, verify size + sha256
#   scripts/model.sh verify [--quiet]                re-check the local file (size + sha256)
#   scripts/model.sh path                            print the local model path (handy for tests/benches)
#   scripts/model.sh push <package> [options]        put ONE file into the app's own files dir on the phone
#
# The bundle is 484 MB and is NOT in git (hard rule: no model weights in git). It lives in
# ~/models/scanlist/ (override with SCANLIST_MODELS_DIR).
#
# Source of the numbers: Hugging Face tree API, read 2026-11-16
#   https://huggingface.co/api/models/litert-community/embeddinggemma-2-740m-litert-lm/tree/main
#   -> path embeddinggemma-2-740m.litertlm, size 484622336,
#      lfs.oid e7a8a2204b91e0f96e92960e84a09a89212e1633dcb7575a9bf3378b4df77f4c
# (docs also quote the same values, but the API is the source of truth; `fetch` re-checks them.)
#
# Background reading: references/embeddinggemma/RECIPE.md §3 (model files, download, push gotcha)
# and references/embeddinggemma/scripts/pixel8/push_model.sh (the Pixel 8 script this push copies).
#
# Download: ~/housekeeper/scripts/resumable-download.sh URL DEST SIZE SHA256 — resumable (curl -C -),
# retries forever, exits 2 on a size/sha mismatch. `fetch` runs it for you, tees to a log, and then
# verifies again itself. Use --detach for a background job (prints pid + log path), which is what the
# hard rules ask for on a 484 MB download:
#     scripts/model.sh fetch --detach && tail -f ~/models/scanlist/fetch.log
#
# Push, and why it is shaped like this (RECIPE.md §3, gotcha 3):
#   * the target dir must be created BY THE APP. `adb shell mkdir -p /sdcard/Android/data/<pkg>/files/...`
#     makes it shell-owned and the app then cannot open the file ("Failed to open LiteRT-LM file").
#     So: `run-as <pkg> mkdir -p` (app uid, debuggable builds) or, failing that, the app must have made
#     the dir itself (launch the app once) — we never mkdir as shell in that path.
#   * push the FILE only, never the containing folder (adb push dir/ onto an existing dir gives models/models/).
#   * stage in /data/local/tmp and `run-as <pkg> cp` it into place, so the copied file is owned by the app.
#   * verify the sha256 ON the device, then delete the staging file.
#
# Push options:
#   --serial <S>        adb serial (default: the only attached device; required if several)
#   --dest external     app external files dir: /sdcard/Android/data/<pkg>/files/models/   (default)
#   --dest internal     app internal files dir: run-as <pkg> files/models/  (debuggable builds only)
#   --dest both         write both
#   --no-verify         skip the on-device sha256 check (not recommended)
#
# Exit codes: 0 ok, 1 usage/environment, 2 download verification failed, 3 local model missing/bad,
#             4 device missing / push failed / on-device sha mismatch.
set -euo pipefail

MODEL_NAME=embeddinggemma-2-740m.litertlm
MODEL_SIZE=484622336
MODEL_SHA256=e7a8a2204b91e0f96e92960e84a09a89212e1633dcb7575a9bf3378b4df77f4c
MODEL_URL="https://huggingface.co/litert-community/embeddinggemma-2-740m-litert-lm/resolve/main/${MODEL_NAME}"
MODEL_SUBDIR=models   # on-device: <files>/models/<file>  (same layout MnemoThera uses)

MODELS_DIR=${SCANLIST_MODELS_DIR:-$HOME/models/scanlist}
RESUMABLE=${SCANLIST_RESUMABLE_DOWNLOAD:-$HOME/housekeeper/scripts/resumable-download.sh}
MODEL_PATH="$MODELS_DIR/$MODEL_NAME"
LOG_FILE="$MODELS_DIR/fetch.log"

say()  { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
die()  { local code=$1; shift; printf '%s\n' "$*" >&2; exit "$code"; }

usage() {
    cat <<'EOF'
ScanList — EmbeddingGemma 2 model provisioning (card S6).

  scripts/model.sh fetch  [--force] [--detach]   download the bundle, verify size + sha256
  scripts/model.sh verify [--quiet]              re-check the local file
  scripts/model.sh path                          print the local model path
  scripts/model.sh push <package> [options]      put ONE file into the app's own files dir

Local file: $SCANLIST_MODELS_DIR (default: ~/models/scanlist) / embeddinggemma-2-740m.litertlm
  size 484622336 B, sha256 e7a8a2204b91e0f96e92960e84a09a89212e1633dcb7575a9bf3378b4df77f4c
  (from the HF tree API, litert-community/embeddinggemma-2-740m-litert-lm)

fetch options:
  --force, -f     delete the local file and start from zero (default: resume/repair it)
  --detach, -d    run the downloader in the background; prints pid + log path

push options:
  --serial <S>    adb serial (default: the only attached device)
  --dest external|internal|both   external file dir is the default; internal needs run-as (debug builds)
  --no-verify     skip the on-device sha256 check

Push never creates the target dir as shell (the app must own it — references/embeddinggemma/RECIPE.md
§3 gotcha): it stages in /data/local/tmp, then `run-as <pkg> cp`s the single file into place.
EOF
}

# ---------------------------------------------------------------- local file checks

file_size() { stat -c%s "$1" 2>/dev/null || echo 0; }
file_sha()  { sha256sum "$1" | cut -d' ' -f1; }

local_state() {  # prints: missing | short | bad | ok
    [ -f "$MODEL_PATH" ] || { echo missing; return; }
    [ "$(file_size "$MODEL_PATH")" -eq "$MODEL_SIZE" ] || { echo short; return; }
    [ "$(file_sha "$MODEL_PATH")" = "$MODEL_SHA256" ] || { echo bad; return; }
    echo ok
}

check_local() {  # check_local <quiet?>  -> exit 3 unless the model is present and verified
    local quiet=${1:-}
    local s; s=$(local_state)
    case $s in
        ok)
            [ "$quiet" = quiet ] || say "OK  $MODEL_PATH  ($MODEL_SIZE B, sha256 $MODEL_SHA256)"
            return 0 ;;
        missing)
            die 3 "model missing: $MODEL_PATH — run: scripts/model.sh fetch" ;;
        short)
            die 3 "model incomplete: $MODEL_PATH is $(file_size "$MODEL_PATH") of $MODEL_SIZE B — resume with: scripts/model.sh fetch" ;;
        bad)
            die 3 "model present but WRONG sha256: $MODEL_PATH has $(file_sha "$MODEL_PATH") want $MODEL_SHA256 — run: scripts/model.sh fetch --force" ;;
    esac
}

# ---------------------------------------------------------------- fetch

cmd_fetch() {
    local force=0 detach=0
    while [ $# -gt 0 ]; do
        case $1 in
            --force|-f) force=1 ;;
            --detach|-d) detach=1 ;;
            -h|--help) usage; return 0 ;;
            *) die 1 "fetch: unknown option '$1' (see --help)" ;;
        esac
        shift
    done

    [ -x "$RESUMABLE" ] || die 1 "resumable downloader not found/executable: $RESUMABLE
   expected the housekeeper script (hard rule: large downloads go through it). Override with
   SCANLIST_RESUMABLE_DOWNLOAD=/path/to/resumable-download.sh"

    mkdir -p "$MODELS_DIR"

    if [ "$force" -eq 0 ]; then
        case $(local_state) in
            ok)
                say "already present and verified: $MODEL_PATH"
                say "size $MODEL_SIZE B, sha256 $MODEL_SHA256"
                return 0 ;;
            short)
                warn "local file is incomplete — resuming from $(file_size "$MODEL_PATH") bytes"
                ;;
            bad)
                warn "local file has the right size but a wrong sha256 — re-downloading from zero"
                warn "(a complete file cannot be resumed; use --force to skip this warning)"
                rm -f "$MODEL_PATH"
                ;;
        esac
    else
        [ -f "$MODEL_PATH" ] && { say "removing $MODEL_PATH (--force)"; rm -f "$MODEL_PATH"; }
    fi

    local args=("$MODEL_URL" "$MODEL_PATH" "$MODEL_SIZE" "$MODEL_SHA256")
    say "download: $MODEL_URL"
    say "        -> $MODEL_PATH"
    say "        expected $MODEL_SIZE B, sha256 $MODEL_SHA256"
    say "        log: $LOG_FILE"

    if [ "$detach" -eq 1 ]; then
        nohup "$RESUMABLE" "${args[@]}" >>"$LOG_FILE" 2>&1 &
        local pid=$!
        say "started in background: pid $pid"
        say "follow with: tail -f $LOG_FILE   (stop with: kill $pid)"
        say "then check:  scripts/model.sh verify"
        return 0
    fi

    # foreground: resumable-download.sh retries until it succeeds, so this may run for a while;
    # output goes to the terminal AND the log.
    local rc=0
    "$RESUMABLE" "${args[@]}" 2>&1 | tee -a "$LOG_FILE" || rc=$?
    if [ "$rc" -eq 2 ]; then
        die 2 "download finished but verification FAILED (see $LOG_FILE) — try: scripts/model.sh fetch --force"
    elif [ "$rc" -ne 0 ]; then
        die 2 "download failed (exit $rc, see $LOG_FILE) — re-run 'scripts/model.sh fetch' to resume"
    fi

    # belt and braces: our own check, independent of the downloader's
    check_local
    say "fetch complete."
}

# ---------------------------------------------------------------- verify / path

cmd_verify() {
    local quiet=0
    while [ $# -gt 0 ]; do
        case $1 in
            --quiet|-q) quiet=1 ;;
            -h|--help) usage; return 0 ;;
            *) die 1 "verify: unknown option '$1'" ;;
        esac
        shift
    done
    local s; s=$(local_state)
    case $s in
        ok)  [ "$quiet" -eq 1 ] || say "OK  $MODEL_PATH  ($MODEL_SIZE B, sha256 $MODEL_SHA256)"; return 0 ;;
        missing) die 3 "missing: $MODEL_PATH (run: scripts/model.sh fetch)" ;;
        short)   die 3 "incomplete: $MODEL_PATH is $(file_size "$MODEL_PATH") of $MODEL_SIZE B (resume: scripts/model.sh fetch)" ;;
        *)   die 3 "BAD: $MODEL_PATH (sha256 $(file_sha "$MODEL_PATH") want $MODEL_SHA256; run: scripts/model.sh fetch --force)" ;;
    esac
}

cmd_path() { check_local quiet; say "$MODEL_PATH"; }

# ---------------------------------------------------------------- adb / push

adb_() { adb -s "$SERIAL" "$@"; }

pick_device() {
    command -v adb >/dev/null 2>&1 || die 4 "adb not found on PATH (install platform-tools / source scripts/android-env.sh)"
    local serials
    serials=$(adb devices | awk 'NR>1 && $2=="device" {print $1}' || true)
    [ -n "$serials" ] || die 4 "no phone on adb — plug it in, unlock it, enable USB debugging ('adb devices' is empty)"
    if [ -n "${SERIAL:-}" ]; then
        printf '%s\n' "$serials" | grep -qx "$SERIAL" || die 4 "serial $SERIAL is not an attached device (attached: $(echo $serials))"
    else
        local n; n=$(printf '%s\n' "$serials" | wc -l)
        [ "$n" -eq 1 ] || die 4 "several devices attached ($(echo $serials)) — pass --serial <S>"
        SERIAL=$serials
    fi
}

run_as_works() { adb_ shell run-as "$PKG" true >/dev/null 2>&1; }

# push_file <remote_path>  — stage in /data/local/tmp, copy with run-as when possible (RECIPE gotcha)
push_file() {
    local remote=$1
    local stage=/data/local/tmp/$MODEL_NAME
    say "staging  $MODEL_NAME -> $stage"
    adb_ push "$MODEL_PATH" "$stage" >/dev/null || die 4 "adb push to $stage failed"
    adb_ shell chmod 644 "$stage" >/dev/null 2>&1 || true

    local ok=0
    if run_as_works; then
        # create the dir as the app (never as shell — that is the ownership trap), then copy as the app.
        adb_ shell run-as "$PKG" mkdir -p "$(dirname "$remote")" >/dev/null 2>&1 || true
        if adb_ shell run-as "$PKG" cp "$stage" "$remote"; then ok=1; fi
    fi
    if [ "$ok" -eq 0 ]; then
        # run-as unavailable (release build) or cp failed: the dir must already belong to the app.
        # Direct push into an app-created dir is the RECIPE's own workaround; push the FILE only.
        warn "run-as copy not possible — falling back to a direct push of the single file"
        warn "(the dir must have been created by the app: launch the app once if this fails)"
        adb_ push "$MODEL_PATH" "$remote" >/dev/null || die 4 "adb push to $remote failed"
    fi
    adb_ shell rm -f "$stage" >/dev/null 2>&1 || true
}

device_sha() { adb_ shell run-as "$PKG" sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }

verify_remote() {  # verify_remote <remote path> <how>
    local remote=$1 how=$2 got=""
    if [ "$how" = run-as ]; then
        got=$(device_sha "$remote" || true)
    else
        got=$(adb_ shell sha256sum "$remote" 2>/dev/null | cut -d' ' -f1 || true)
    fi
    if [ "$got" != "$MODEL_SHA256" ]; then
        die 4 "on-device sha256 mismatch for $remote (got '${got:-nothing}', want $MODEL_SHA256)
   if the app reports 'Failed to open LiteRT-LM file', the dir is not owned by the app — the
   RECIPE gotcha: let the app create it (launch the app once, then re-run push)."
    fi
    say "OK  on-device sha256 matches: $remote"
}

cmd_push() {
    local pkg="" dest=external do_verify=1
    while [ $# -gt 0 ]; do
        case $1 in
            --serial) SERIAL=${2:?--serial needs a value}; shift ;;
            --serial=*) SERIAL=${1#*=} ;;
            --dest) dest=${2:?--dest needs a value}; shift ;;
            --dest=*) dest=${1#*=} ;;
            --package) pkg=${2:?--package needs a value}; shift ;;
            --no-verify) do_verify=0 ;;
            -h|--help) usage; return 0 ;;
            -*) die 1 "push: unknown option '$1'" ;;
            *) [ -n "$pkg" ] && die 1 "push: package given twice"; pkg=$1 ;;
        esac
        shift
    done
    [ -n "$pkg" ] || die 1 "push: need the app package id, e.g. scripts/model.sh push dev.hajnina.scanlist.kotlin"
    case $dest in external|internal|both) ;; *) die 1 "push: --dest must be external, internal or both" ;; esac

    check_local
    pick_device
    PKG=$pkg
    say "device $SERIAL, package $PKG, dest $dest"

    local installed
    installed=$(adb_ shell pm path "$PKG" 2>/dev/null | tr -d '\r' || true)
    [ -n "$installed" ] || die 4 "$PKG is not installed on $SERIAL"

    local ext_dir=/sdcard/Android/data/$PKG/files/$MODEL_SUBDIR
    local int_dir=files/$MODEL_SUBDIR   # relative: inside run-as

    case $dest in
        external|both)
            if ! adb_ shell test -d "/sdcard/Android/data/$PKG/files" >/dev/null 2>&1; then
                die 4 "/sdcard/Android/data/$PKG/files does not exist yet.
   The app must create it (launch $PKG once, open whatever screen initialises models), so the dir is
   app-owned. Do NOT create it with 'adb shell mkdir' — the app cannot open files in a shell-owned dir."
            fi
            if ! adb_ shell test -d "$ext_dir" >/dev/null 2>&1; then
                die 4 "$ext_dir ($MODEL_SUBDIR) does not exist yet — only the app may create it.
   Launch $PKG once so the app creates $MODEL_SUBDIR (never 'adb shell mkdir'), then re-run push.
   (An 'adb push' here would create it shell-owned and the app could never open the file.)"
            fi
            push_file "$ext_dir/$MODEL_NAME"
            [ "$do_verify" -eq 1 ] && { if run_as_works; then verify_remote "$ext_dir/$MODEL_NAME" run-as; else verify_remote "$ext_dir/$MODEL_NAME" shell; fi; }
            ;;
    esac

    case $dest in
        internal|both)
            run_as_works || die 4 "run-as $PKG does not work (release/non-debuggable build) — use --dest external"
            push_file "$int_dir/$MODEL_NAME"
            if [ "$do_verify" -eq 1 ]; then
                local got; got=$(adb_ shell run-as "$PKG" sha256sum "$int_dir/$MODEL_NAME" 2>/dev/null | cut -d' ' -f1 || true)
                [ "$got" = "$MODEL_SHA256" ] || die 4 "on-device sha256 mismatch for internal $int_dir/$MODEL_NAME (got '${got:-nothing}')"
                say "OK  on-device sha256 matches: <app internal>/$int_dir/$MODEL_NAME"
            fi
            ;;
    esac

    say "push complete. Models on device:"
    case $dest in external|both) adb_ shell ls -l "$ext_dir" 2>/dev/null || true ;; esac
    say
    say "The app reads $MODEL_SUBDIR/$MODEL_NAME from its own files dir; keep the on-device copy in sync with"
    say "sha256 $MODEL_SHA256 (a mismatched weight file silently changes the golden vectors)."
}

# ---------------------------------------------------------------- main

# resolve --serial early so every subcommand can mention it in help output; kept in one variable
PKG=${PKG:-} SERIAL=${SERIAL:-}

cmd=${1:-}; [ $# -gt 0 ] && shift || true
case $cmd in
    fetch)  cmd_fetch "$@" ;;
    verify) cmd_verify "$@" ;;
    path)   cmd_path "$@" ;;
    push)   cmd_push "$@" ;;
    ""|-h|--help|help) usage ;;
    *) die 1 "unknown command '$cmd' (fetch|verify|path|push) — see --help" ;;
esac
