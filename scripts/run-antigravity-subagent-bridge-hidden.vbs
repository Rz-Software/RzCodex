Option Explicit

Dim Shell, NodePath, BridgePath, Command

NodePath = "C:\Program Files\nodejs\node.exe"
BridgePath = "C:\Users\Rz\source\repos\RzCodex\scripts\antigravity-subagent-bridge.mjs"
Command = Chr(34) & NodePath & Chr(34) & " " & Chr(34) & BridgePath & Chr(34)

Set Shell = CreateObject("WScript.Shell")
WScript.Quit Shell.Run(Command, 0, True)
