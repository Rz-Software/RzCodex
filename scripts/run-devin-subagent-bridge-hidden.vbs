Option Explicit

Dim Shell, FileSystem, NodePath, BridgePath, LogDirectory, LogPath
Dim Command, ExitCode, DelayMilliseconds, StartedAt, RuntimeSeconds, LogFile

NodePath = "C:\Program Files\nodejs\node.exe"
BridgePath = "C:\Users\Rz\source\repos\RzCodex\scripts\devin-subagent-bridge.mjs"
Set Shell = CreateObject("WScript.Shell")
Set FileSystem = CreateObject("Scripting.FileSystemObject")

LogDirectory = Shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\RzCodex\Logs")
LogPath = LogDirectory & "\devin-subagent-bridge.log"
If Not FileSystem.FolderExists(LogDirectory) Then
    FileSystem.CreateFolder LogDirectory
End If

Command = Chr(34) & Shell.ExpandEnvironmentStrings("%ComSpec%") & Chr(34) & _
    " /d /s /c " & Chr(34) & Chr(34) & NodePath & Chr(34) & " " & _
    Chr(34) & BridgePath & Chr(34) & " >> " & Chr(34) & LogPath & Chr(34) & _
    " 2>&1" & Chr(34)
DelayMilliseconds = 5000

Do
    StartedAt = Timer
    ExitCode = Shell.Run(Command, 0, True)
    RuntimeSeconds = Timer - StartedAt
    If RuntimeSeconds < 0 Then RuntimeSeconds = RuntimeSeconds + 86400

    Set LogFile = FileSystem.OpenTextFile(LogPath, 8, True)
    LogFile.WriteLine Now & " supervisor: bridge exited with code " & ExitCode & _
        " after " & CLng(RuntimeSeconds) & "s; retrying in " & _
        (DelayMilliseconds \ 1000) & "s"
    LogFile.Close

    WScript.Sleep DelayMilliseconds
    If RuntimeSeconds >= 300 Then
        DelayMilliseconds = 5000
    ElseIf DelayMilliseconds < 30000 Then
        DelayMilliseconds = DelayMilliseconds * 2
        If DelayMilliseconds > 30000 Then DelayMilliseconds = 30000
    End If
Loop
