@{
    schema = 1
    os = [Environment]::OSVersion.Platform.ToString()
    version = $PSVersionTable.PSVersion.ToString()
    cim = [bool](Get-Command Get-CimInstance -CommandType Cmdlet -ErrorAction SilentlyContinue)
}
