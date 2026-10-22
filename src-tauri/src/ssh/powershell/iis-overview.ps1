$r = @{schema=1; status='unavailable'; sites=$null; pools=$null; truncated=$false}
$dll = Join-Path ([Environment]::SystemDirectory) 'inetsrv\Microsoft.Web.Administration.dll'
$m = $null
try {
    if (!(Test-Path -LiteralPath $dll)) { $r.status='not_installed'; return $r }
    [void][Reflection.Assembly]::LoadFrom($dll)
    $m = New-Object Microsoft.Web.Administration.ServerManager
    $r.status = 'available'
    try {
        $all = $m.Sites
        if ($null -eq $all) { throw 'Sites unavailable' }
        if ($all.Count -gt 200) { $r.truncated=$true }
        $r.sites = @($all | Select-Object -First 200 | ForEach-Object {
            $s = $_
            if ($null -eq $s.Bindings -or $null -eq $s.Applications -or $null -eq $s.LogFile.Enabled) { throw 'Site details unavailable' }
            $state = $null
            try { $state = $s.State.ToString() } catch {}
            if ($s.Bindings.Count -gt 64 -or $s.Applications.Count -gt 64) { $r.truncated=$true }
            $bindings = @($s.Bindings | Select-Object -First 64 | ForEach-Object {
                @{protocol=$_.Protocol; address=$_.BindingInformation}
            })
            $apps = @($s.Applications | Select-Object -First 64 | ForEach-Object {
                @{path=$_.Path; pool=$_.ApplicationPoolName}
            })
            @{id=$s.Id; name=$s.Name; state=$state; bindings=$bindings; applications=$apps; log_enabled=$s.LogFile.Enabled}
        })
    } catch { $r.sites=$null }
    try {
        $all = $m.ApplicationPools
        if ($null -eq $all) { throw 'Pools unavailable' }
        if ($all.Count -gt 200) { $r.truncated=$true }
        $r.pools = @($all | Select-Object -First 200 | ForEach-Object {
            $state = $null
            try { $state = $_.State.ToString() } catch {}
            @{name=$_.Name; state=$state; runtime=$_.ManagedRuntimeVersion; pipeline=$_.ManagedPipelineMode.ToString()}
        })
    } catch { $r.pools=$null }
} catch { $r.status='unavailable'; $r.sites=$null; $r.pools=$null }
finally { if ($null -ne $m) { $m.Dispose() } }
$r
