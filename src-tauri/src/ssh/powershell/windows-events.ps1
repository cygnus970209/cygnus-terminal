$logs = @('Application','System' | ForEach-Object {
    $name = $_
    $events = $null
    try {
        $events = @(Get-WinEvent -FilterHashtable @{LogName=$name; Level=1,2,3; StartTime=(Get-Date).AddHours(-24)} -MaxEvents 20 | ForEach-Object {
            $e = $_
            $message = $null
            $cut = $false
            try {
                $message = $e.Message
                if ($null -ne $message -and $message.Length -gt 1024) { $message=$message.Substring(0,1024); $cut=$true; if ([char]::IsHighSurrogate($message[1023])) { $message=$message.Substring(0,1023) } }
            } catch {}
            $time = $null
            if ($null -ne $e.TimeCreated) { $time=$e.TimeCreated.ToUniversalTime().ToString('o') }
            @{record_id=$e.RecordId; id=$e.Id; level=$e.Level; provider=$e.ProviderName; time=$time; message=$message; message_truncated=$cut}
        })
    } catch {
        if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { $events=@() } else { $events=$null }
    }
    @{name=$name; events=$events}
})
@{schema=1; logs=$logs}
