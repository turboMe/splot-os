#!/bin/bash
# AuthorClaw Recovery Tool
echo ""
echo "  🔧 AuthorClaw Recovery"
echo "  ═══════════════════════"
echo ""
echo "  1) Clear conversation cache"
echo "  2) Reset memory (keeps book bibles)"
echo "  3) Clear cost limits"
echo "  4) Reset permissions to standard"
echo "  5) Fix file permissions"
echo "  6) Factory reset (⚠️ keeps projects & vault)"
echo "  7) Exit"
echo ""
read -p "  Choose [1-7]: " CHOICE

case $CHOICE in
    1) rm -rf workspace/memory/conversations/* && echo "  ✓ Conversation cache cleared" ;;
    2) rm -rf workspace/memory/conversations/* workspace/memory/voice-data/* && echo "  ✓ Memory reset (book bibles preserved)" ;;
    3) echo "  ✓ Cost limits will reset on next startup" ;;
    4) echo '{"security":{"permissionPreset":"standard"}}' > config/user.json && echo "  ✓ Permissions reset to standard" ;;
    5) chmod -R u+rw workspace/ && echo "  ✓ File permissions fixed" ;;
    6) rm -rf workspace/memory/conversations/* workspace/memory/voice-data/* workspace/.audit/* && echo "  ✓ Factory reset complete (projects & vault preserved)" ;;
    7) echo "  Goodbye!" ;;
    *) echo "  Invalid choice" ;;
esac
echo ""
