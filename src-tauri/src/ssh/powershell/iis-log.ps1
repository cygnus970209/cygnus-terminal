$r=@{schema=1; site_id=$siteId; status='unavailable'; file=$null; lines=@(); truncated=$false}
$m=$null; $f=$null
try {
    $dll=Join-Path ([Environment]::SystemDirectory) 'inetsrv\Microsoft.Web.Administration.dll'
    [void][Reflection.Assembly]::LoadFrom($dll)
    $m=New-Object Microsoft.Web.Administration.ServerManager
    if ($null -eq $m.Sites) { throw 'Sites unavailable' }
    $s=@($m.Sites | Where-Object { $_.Id -eq $siteId })
    if ($s.Count -ne 1) { $r.status='site_missing'; return $r }
    $s=$s[0]
    if ($null -eq $s.LogFile.Enabled) { throw 'Log unavailable' }
    if (!$s.LogFile.Enabled) { $r.status='disabled'; return $r }
    $mode=$m.GetApplicationHostConfiguration().GetSection('system.applicationHost/log')['centralLogFileMode'].ToString()
    if ($mode -ne 'Site' -or $s.LogFile.LogFormat.ToString() -ne 'W3C') { $r.status='unsupported_format'; return $r }
    $p=[Environment]::ExpandEnvironmentVariables($s.LogFile.Directory)
    if ($p -notmatch '^[a-zA-Z]:\\' -or $p.Substring(2).Contains(':')) { $r.status='unsupported_path'; return $r }
    $p=[IO.Path]::GetFullPath((Join-Path $p "W3SVC$siteId"))
    $root=[IO.Path]::GetPathRoot($p)
    if (([IO.DriveInfo]::new($root)).DriveType -ne 'Fixed') { $r.status='unsupported_path'; return $r }
    $at=$root
    foreach ($part in $p.Substring($root.Length).Split('\')) {
        $at=Join-Path $at $part
        if (!(Test-Path -LiteralPath $at)) { $r.status='no_logs'; return $r }
        if ((Get-Item -LiteralPath $at).Attributes -band [IO.FileAttributes]::ReparsePoint) { $r.status='unsupported_path'; return $r }
    }
    $files=@(Get-ChildItem -LiteralPath $p -File -Filter '*.log' | Select-Object -First 4097)
    if ($files.Count -gt 4096) { $r.status='too_many_files'; return $r }
    if (!$files.Count) { $r.status='no_logs'; return $r }
    $last=$files | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ($last.Attributes -band [IO.FileAttributes]::ReparsePoint) { $r.status='unsupported_path'; return $r }
    $f=[IO.File]::Open($last.FullName,'Open','Read',([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    $skip=[Math]::Max(0,$f.Length-16384)
    [void]$f.Seek($skip,'Begin')
    $buf=New-Object byte[] 16384
    $n=0
    while ($n -lt $buf.Length) { $read=$f.Read($buf,$n,$buf.Length-$n); if (!$read) { break }; $n+=$read }
    $lines=@([Text.Encoding]::UTF8.GetString($buf,0,$n) -split '\r?\n')
    if ($skip -gt 0) { $lines=@($lines | Select-Object -Skip 1) }
    $r.truncated=($skip -gt 0 -or $lines.Count -gt 50)
    $r.lines=@($lines | Select-Object -Last 50)
    $r.file=$last.Name; $r.status='available'
} catch { $r.status='unavailable'; $r.file=$null; $r.lines=@(); $r.truncated=$false }
finally { if ($null -ne $f) { $f.Dispose() }; if ($null -ne $m) { $m.Dispose() } }
$r
