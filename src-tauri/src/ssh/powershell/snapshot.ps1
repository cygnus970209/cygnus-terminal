$r = @{schema=1; cpu=$null; memory=$null; disks=$null; uptime_seconds=$null; processes=$null}
try {
    $cpu = @(Get-CimInstance Win32_Processor -Property LoadPercentage,NumberOfLogicalProcessors -OperationTimeoutSec 3 | ForEach-Object {
        if ($null -eq $_.LoadPercentage -or $null -eq $_.NumberOfLogicalProcessors) { throw 'Unavailable' }
        @{load=$_.LoadPercentage; logical=$_.NumberOfLogicalProcessors}
    })
    $r.cpu = $cpu
} catch {}
try {
    $os = Get-CimInstance Win32_OperatingSystem -Property TotalVisibleMemorySize,FreePhysicalMemory,LastBootUpTime -OperationTimeoutSec 3
    if ($null -ne $os.TotalVisibleMemorySize -and $null -ne $os.FreePhysicalMemory) {
        $r.memory = @{total_kib=$os.TotalVisibleMemorySize; free_kib=$os.FreePhysicalMemory}
    }
    if ($null -ne $os.LastBootUpTime) {
        $r.uptime_seconds = [long][Math]::Floor(([DateTime]::UtcNow - $os.LastBootUpTime.ToUniversalTime()).TotalSeconds)
    }
} catch {}
try {
    $disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -Property DeviceID,Size,FreeSpace -OperationTimeoutSec 3 | ForEach-Object {
        if ($null -eq $_.Size -or $null -eq $_.FreeSpace) { throw 'Unavailable' }
        @{name=$_.DeviceID; total_bytes=$_.Size; free_bytes=$_.FreeSpace}
    })
    $r.disks = $disks
} catch {}
try {
    $processes = @(Get-CimInstance Win32_Process -Property ProcessId,Name,WorkingSetSize -OperationTimeoutSec 3 |
        Sort-Object -Property WorkingSetSize -Descending | Select-Object -First 20 | ForEach-Object {
            if ($null -eq $_.ProcessId -or $null -eq $_.Name -or $null -eq $_.WorkingSetSize) { throw 'Unavailable' }
            @{pid=$_.ProcessId; name=$_.Name; memory_bytes=$_.WorkingSetSize}
        })
    $r.processes = $processes
} catch {}
$r
