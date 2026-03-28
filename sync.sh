#!/bin/bash
# sync.sh - Syncs skills between this repo and ~/.claude/skills/
# Usage: ./sync.sh [push|pull|status]

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_DIR="$REPO_DIR/skills"
CLAUDE_SKILLS="$HOME/.claude/skills"

case "${1:-status}" in
  push)
    # Copy skills from repo to ~/.claude/skills/
    echo "=== Pushing skills to ~/.claude/skills/ ==="
    for skill_dir in "$SKILLS_DIR"/*/; do
      skill_name=$(basename "$skill_dir")
      target="$CLAUDE_SKILLS/$skill_name"
      if [ -d "$target" ]; then
        echo "  UPDATE: $skill_name"
      else
        echo "  NEW:    $skill_name"
        mkdir -p "$target"
      fi
      cp -r "$skill_dir"* "$target/"
    done
    echo "Done."
    ;;

  pull)
    # Copy skills from ~/.claude/skills/ into repo
    echo "=== Pulling skills from ~/.claude/skills/ ==="
    for skill_dir in "$CLAUDE_SKILLS"/*/; do
      skill_name=$(basename "$skill_dir")
      target="$SKILLS_DIR/$skill_name"
      if [ -d "$target" ]; then
        echo "  SKIP (already in repo): $skill_name"
      else
        echo "  IMPORT: $skill_name"
        mkdir -p "$target"
        cp -r "$skill_dir"* "$target/"
      fi
    done
    echo "Done. Review imported skills and update registry.json."
    ;;

  status)
    echo "=== Skills Status ==="
    echo ""
    echo "In repo (skills/):"
    for d in "$SKILLS_DIR"/*/; do
      [ -d "$d" ] && echo "  $(basename "$d")"
    done
    echo ""
    echo "In inbox (pending review):"
    for d in "$REPO_DIR/inbox"/*/; do
      [ -d "$d" ] && echo "  $(basename "$d")"
    done
    echo ""
    echo "In ~/.claude/skills/ (active):"
    for d in "$CLAUDE_SKILLS"/*/; do
      [ -d "$d" ] && echo "  $(basename "$d")"
    done
    ;;

  *)
    echo "Usage: ./sync.sh [push|pull|status]"
    ;;
esac
