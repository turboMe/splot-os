# ═══════════════════════════════════════════════════════════
# AuthorClaw - Prepare VirtualBox VM
# Run this on Windows BEFORE starting the VM
# Resizes disk, increases RAM, renames VM
#
# Prerequisites: VirtualBox must be installed, VM must be powered off
# ═══════════════════════════════════════════════════════════

$ErrorActionPreference = "Stop"

$VBoxManage = "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe"
$VMName = "Moat Mini Sandbox"
$NewVMName = "AuthorClaw"
$VDIPath = Join-Path $env:USERPROFILE "VirtualBox VMs\$VMName\$VMName.vdi"

# ── Check VBoxManage exists ──
if (-not (Test-Path $VBoxManage)) {
    Write-Error "VBoxManage not found at: $VBoxManage"
    Write-Host "Is VirtualBox installed?"
    exit 1
}

# ── Check VM is powered off ──
$vmInfo = & $VBoxManage showvminfo $VMName --machinereadable 2>&1
if ($vmInfo -match 'VMState="running"') {
    Write-Error "VM '$VMName' is currently running. Please power it off first."
    exit 1
}

Write-Host ""
Write-Host "  AuthorClaw - VM Preparation" -ForegroundColor Cyan
Write-Host "  ======================================="
Write-Host ""

# ── Step 1: Resize disk to 50GB ──
Write-Host "  [1/5] Resizing disk to 50 GB..."
$newSizeMB = 50 * 1024  # 50 GB in MB
try {
    & $VBoxManage modifymedium disk $VDIPath --resize $newSizeMB 2>&1
    Write-Host "  OK: Disk resized to 50 GB" -ForegroundColor Green
    Write-Host "  NOTE: You'll need to expand the partition inside the VM" -ForegroundColor Yellow
    Write-Host "        Run: sudo growpart /dev/sda 2 && sudo resize2fs /dev/sda2" -ForegroundColor Yellow
} catch {
    Write-Host "  WARN: Disk resize failed (may already be larger): $_" -ForegroundColor Yellow
}

# ── Step 2: Increase RAM to 8GB ──
Write-Host "  [2/5] Setting RAM to 8192 MB (8 GB)..."
& $VBoxManage modifyvm $VMName --memory 8192
Write-Host "  OK: RAM set to 8 GB" -ForegroundColor Green

# ── Step 3: Set CPUs to 4 ──
Write-Host "  [3/5] Setting CPU count to 4..."
& $VBoxManage modifyvm $VMName --cpus 4
Write-Host "  OK: CPUs set to 4" -ForegroundColor Green

# ── Step 4: Update shared folder to point to AuthorClaw transfer directory ──
Write-Host "  [4/5] Configuring shared folder..."
$SharedPath = Join-Path (Split-Path $PSScriptRoot) "vm-transfer"

# Remove old shared folders and add new one
try { & $VBoxManage sharedfolder remove $VMName --name "moat-bot-mini" 2>$null } catch {}
try { & $VBoxManage sharedfolder remove $VMName --name "authorclaw-transfer" 2>$null } catch {}
& $VBoxManage sharedfolder add $VMName --name "authorclaw-transfer" --hostpath $SharedPath --automount
Write-Host "  OK: Shared folder configured at $SharedPath" -ForegroundColor Green

# ── Step 5: Add port forwarding for AuthorClaw dashboard ──
Write-Host "  [5/5] Adding port forwarding (host:3847 -> guest:3847)..."
try {
    & $VBoxManage modifyvm $VMName --natpf1 delete "authorclaw" 2>$null
} catch {}
& $VBoxManage modifyvm $VMName --natpf1 "authorclaw,tcp,,3847,,3847"
Write-Host "  OK: Port 3847 forwarded (access dashboard from Windows)" -ForegroundColor Green

# ── Rename VM (optional - do this last) ──
Write-Host ""
Write-Host "  To rename the VM to 'AuthorClaw', run:" -ForegroundColor Yellow
Write-Host "    & '$VBoxManage' modifyvm '$VMName' --name '$NewVMName'" -ForegroundColor Yellow
Write-Host "  (Not done automatically to avoid path confusion)" -ForegroundColor Yellow

Write-Host ""
Write-Host "  =======================================" -ForegroundColor Cyan
Write-Host "  VM is ready! Start it from VirtualBox." -ForegroundColor Cyan
Write-Host ""
Write-Host "  After starting the VM:" -ForegroundColor White
Write-Host "  1. Expand the disk partition inside Ubuntu:" -ForegroundColor White
Write-Host "     sudo growpart /dev/sda 2 && sudo resize2fs /dev/sda2" -ForegroundColor White
Write-Host "  2. Copy files from shared folder:" -ForegroundColor White
Write-Host "     cp -r /media/sf_authorclaw-transfer/authorclaw ~/authorclaw" -ForegroundColor White
Write-Host "     cp -r /media/sf_authorclaw-transfer/author-os ~/author-os" -ForegroundColor White
Write-Host "  3. Run setup: ~/authorclaw/scripts/vm-setup.sh" -ForegroundColor White
Write-Host "  4. Log out/in, then deploy: ~/authorclaw/scripts/deploy.sh" -ForegroundColor White
Write-Host "  =======================================" -ForegroundColor Cyan
Write-Host ""
