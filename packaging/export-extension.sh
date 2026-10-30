#!/usr/bin/env bash
# Exports Kiori's SillyTavern extension (kiori/sillytavern/) as a standalone git repository with manifest.json at its
# root, which is what SillyTavern's "Install extension" clones.
#
#   packaging/export-extension.sh <new-folder>            a new repository on branch main, every file staged
#   packaging/export-extension.sh --no-git <new-folder>   the files only, to copy into a clone you already have
#
# It writes only into <new-folder>, which must not exist yet or be empty, and must be outside the kiori repository.
# It never commits, pushes, deletes or overwrites anything. Works with macOS's bash 3.2.
set -euo pipefail

me="export-extension"
usage() {
    cat <<'EOF'
Usage: packaging/export-extension.sh [--no-git] <new-folder>

Copies kiori/sillytavern/ into <new-folder> as a standalone repository for SillyTavern's
"Install extension": manifest.json at its root, branch main, every file staged, nothing committed.

  --no-git   copy the files only (to sync them into a clone you already have)

<new-folder> must not exist yet, or be empty, and must be outside the kiori repository.
EOF
}
fail() { echo "$me: $*" >&2; exit 1; }

git_init=1
target=""
while [ $# -gt 0 ]; do
    case "$1" in
        --no-git) git_init=0 ;;
        -h|--help) usage; exit 0 ;;
        -*) echo "$me: unknown option $1" >&2; usage >&2; exit 2 ;;
        *)
            if [ -n "$target" ]; then echo "$me: give one folder" >&2; usage >&2; exit 2; fi
            target="$1"
            ;;
    esac
    shift
done
if [ -z "$target" ]; then usage >&2; exit 2; fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(cd "$here/.." && pwd -P)"
src="$root/sillytavern"

# The source: an extension SillyTavern can load, with what a public repository needs
[ -d "$src" ] || fail "there is no extension at $src"
for f in manifest.json README.md LICENSE; do
    [ -f "$src/$f" ] || fail "$src/$f is missing"
done
ext_name="Kiori"
ext_version=""
if command -v node >/dev/null 2>&1; then
    # SillyTavern requires display_name, js and author (docs.sillytavern.app, Writing extensions, Manifest fields)
    about="$(node -e '
        const fs = require("fs"), path = require("path"), dir = process.argv[1];
        const stop = why => { console.error(why); process.exit(1); };
        let m;
        try { m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")); }
        catch (e) { stop(`manifest.json is not valid JSON: ${e.message}`); }
        for (const k of ["display_name", "js", "author"]) if (!m[k]) stop(`manifest.json has no "${k}"`);
        for (const f of [m.js, m.css].filter(Boolean)) if (!fs.existsSync(path.join(dir, f))) stop(`manifest.json names ${f}, which is missing`);
        console.log(`${m.display_name}|${m.version || ""}`);
    ' "$src")" || fail "the extension in $src isn't ready (see above); nothing written"
    ext_name="${about%%|*}"
    ext_version="${about#*|}"
else
    echo "$me: node isn't installed, so manifest.json wasn't checked" >&2
fi
if [ "$git_init" = 1 ] && ! command -v git >/dev/null 2>&1; then
    fail "git isn't installed; install it, or use --no-git for the files only. Nothing written."
fi

# The target: its real absolute path, though it may not exist yet (the nearest existing folder, resolved, plus the rest)
resolve() {
    local p="$1" rest=""
    case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
    while [ ! -d "$p" ]; do
        if [ -e "$p" ] || [ -L "$p" ]; then fail "$p exists and isn't a folder; nothing written"; fi
        rest="/$(basename "$p")$rest"
        p="$(dirname "$p")"
    done
    echo "$(cd "$p" && pwd -P)$rest"
}
dest="$(resolve "$target")"
case "$dest/" in
    "$root/"*) fail "$dest is inside the kiori repository; pick a folder outside it. Nothing written." ;;
esac
if [ -d "$dest" ]; then
    if [ ! -r "$dest" ] || [ ! -x "$dest" ]; then fail "can't read $dest; nothing written"; fi
    if [ -n "$(ls -A "$dest")" ]; then
        fail "$dest isn't empty; nothing written. Pick a new folder, or empty this one yourself."
    fi
fi

# Where the source stands (read-only: no optional locks, so not even git's index is touched)
rev="unknown"
changes=""
if command -v git >/dev/null 2>&1 && git -C "$root" rev-parse --git-dir >/dev/null 2>&1; then
    rev="$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    changes="$(git --no-optional-locks -C "$root" status --porcelain -- sillytavern 2>/dev/null || true)"
fi
outer=""
if command -v git >/dev/null 2>&1; then
    probe="$dest"
    while [ ! -d "$probe" ]; do probe="$(dirname "$probe")"; done
    outer="$(git -C "$probe" rev-parse --show-toplevel 2>/dev/null || true)"
fi

# The copy: every file of the extension, Finder's .DS_Store aside
mkdir -p "$dest"
copied=""
for entry in "$src"/* "$src"/.[!.]* "$src"/..?*; do
    [ -e "$entry" ] || continue
    name="$(basename "$entry")"
    case "$name" in .DS_Store|.git) continue ;; esac
    cp -R "$entry" "$dest/"
    copied="$copied $name"
done

left=""
for f in "$dest"/*; do
    [ -f "$f" ] || continue
    if grep -q -e '\[COPYRIGHT HOLDER\]' -e '{EXTENSION_REPO_URL}' "$f"; then left="$left $(basename "$f")"; fi
done

if [ "$git_init" = 1 ]; then
    git -C "$dest" init -q
    git -C "$dest" symbolic-ref HEAD refs/heads/main
    git -C "$dest" add -A
fi

title="$ext_name for SillyTavern${ext_version:+ $ext_version}"
echo "Exported $title (from kiori at $rev) to $dest:"
echo "  ${copied# }"
if [ "$git_init" = 1 ]; then
    echo "It's a new git repository on branch main, with every file staged. Nothing is committed or pushed."
else
    echo "Files only, no repository."
fi
if [ -n "$outer" ]; then
    echo
    echo "Note: $dest is inside another git repository ($outer)."
fi
if [ -n "$changes" ]; then
    echo
    echo "Warning: kiori/sillytavern/ has changes that aren't committed in kiori, so this export doesn't match $rev:"
    echo "$changes" | sed 's/^/  /'
    echo "Commit them in kiori, then export again into a new folder, so the public repo and kiori stay the same."
fi
if [ -n "$left" ]; then
    echo
    echo "Warning: placeholders are still in:$left"
    echo "Replace [COPYRIGHT HOLDER] and {EXTENSION_REPO_URL} in kiori/sillytavern/, commit, and export again."
fi
echo
if [ "$git_init" = 1 ]; then
    git_name="$(git -C "$dest" config user.name 2>/dev/null || true)"
    git_email="$(git -C "$dest" config user.email 2>/dev/null || true)"
    if [ -n "$git_name" ] && [ -n "$git_email" ]; then
        echo "The first commit will show this name and email publicly: $git_name <$git_email>"
        echo "To use another one in this repository only, run there: git config user.email \"<address>\""
        echo
        echo "Next:"
        echo "  cd \"$dest\""
    else
        echo "git has no name and email here to sign the first commit with. Both will be public: pick them with care."
        echo
        echo "Next:"
        echo "  cd \"$dest\""
        echo "  git config user.name \"<name>\""
        echo "  git config user.email \"<address>\""
    fi
    echo "  git commit -m \"$title\""
    echo "  git remote add origin https://github.com/kiori-ai/SillyTavern-Kiori.git"
    echo "  git push -u origin main"
else
    echo "Next: copy these files into your clone of the extension repo, then commit and push there."
fi
