using System;
using System.Runtime.InteropServices;
using System.Text;

namespace RzCodex
{
    /// <summary>
    /// Windows-subsystem bootstrap for RzCodex bridge scheduled tasks.
    /// Creates the target process suspended, assigns it to a kill-on-close job,
    /// then resumes the main thread. This prevents the child from running before
    /// it is owned and avoids visible console windows.
    /// </summary>
    internal static class BridgeLauncher
    {
        private const int ExitCodeNoArguments = 3;
        private const int ExitCodeJobSetupFailed = 4;
        private const int ExitCodeSpawnFailed = 5;
        private const int ExitCodeJobAttachFailed = 6;

        private const uint JobObjectLimitKillOnJobClose = 0x00002000;
        private const int JobObjectExtendedLimitInformation = 9;

        private const uint CreateNoWindow = 0x08000000;
        private const uint CreateSuspended = 0x00000004;
        private const uint Infinite = 0xFFFFFFFF;
        private const uint WaitObject0 = 0;

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct STARTUPINFO
        {
            public uint cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public uint dwX;
            public uint dwY;
            public uint dwXSize;
            public uint dwYSize;
            public uint dwXCountChars;
            public uint dwYCountChars;
            public uint dwFillAttribute;
            public uint dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(
            IntPtr hJob,
            int JobObjectInformationClass,
            ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInformation,
            int cbJobObjectInformationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateProcess(
            string lpApplicationName,
            StringBuilder lpCommandLine,
            IntPtr lpProcessAttributes,
            IntPtr lpThreadAttributes,
            bool bInheritHandles,
            uint dwCreationFlags,
            IntPtr lpEnvironment,
            string lpCurrentDirectory,
            ref STARTUPINFO lpStartupInfo,
            out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr hThread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

        private static int Main(string[] args)
        {
            if (args.Length == 0)
            {
                return ExitCodeNoArguments;
            }

            var line = JoinArguments(args, 0);
            var commandLine = new StringBuilder(32768);
            commandLine.Append(line);

            var jobHandle = CreateJobObject(IntPtr.Zero, null);
            var invalidHandle = new IntPtr(-1);
            if (jobHandle == IntPtr.Zero || jobHandle == invalidHandle)
            {
                return ExitCodeJobSetupFailed;
            }

            try
            {
                var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
                if (!SetInformationJobObject(
                    jobHandle,
                    JobObjectExtendedLimitInformation,
                    ref limits,
                    Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                {
                    return ExitCodeJobSetupFailed;
                }

                var startupInfo = new STARTUPINFO { cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO)) };
                PROCESS_INFORMATION processInfo;
                if (!CreateProcess(
                    args[0],
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    false,
                    CreateNoWindow | CreateSuspended,
                    IntPtr.Zero,
                    null,
                    ref startupInfo,
                    out processInfo))
                {
                    return ExitCodeSpawnFailed;
                }

                try
                {
                    if (!AssignProcessToJobObject(jobHandle, processInfo.hProcess))
                    {
                        TerminateProcess(processInfo.hProcess, (uint)ExitCodeJobAttachFailed);
                        return ExitCodeJobAttachFailed;
                    }

                    if (ResumeThread(processInfo.hThread) == uint.MaxValue)
                    {
                        TerminateProcess(processInfo.hProcess, (uint)ExitCodeSpawnFailed);
                        return ExitCodeSpawnFailed;
                    }

                    if (WaitForSingleObject(processInfo.hProcess, Infinite) != WaitObject0)
                    {
                        return ExitCodeSpawnFailed;
                    }

                    uint exitCode;
                    if (!GetExitCodeProcess(processInfo.hProcess, out exitCode))
                    {
                        return ExitCodeSpawnFailed;
                    }
                    return (int)exitCode;
                }
                finally
                {
                    CloseHandle(processInfo.hThread);
                    CloseHandle(processInfo.hProcess);
                }
            }
            finally
            {
                CloseHandle(jobHandle);
            }
        }

        private static string JoinArguments(string[] args, int startIndex)
        {
            var builder = new StringBuilder();
            for (var i = startIndex; i < args.Length; i++)
            {
                if (i > startIndex)
                {
                    builder.Append(' ');
                }
                builder.Append(EscapeArgument(args[i]));
            }
            return builder.ToString();
        }

        private static string EscapeArgument(string arg)
        {
            if (string.IsNullOrEmpty(arg))
            {
                return "\"\"";
            }

            var needsQuotes = false;
            for (var i = 0; i < arg.Length; i++)
            {
                var c = arg[i];
                if (c == ' ' || c == '\t' || c == '"' || c == '\\')
                {
                    needsQuotes = true;
                    break;
                }
            }

            if (!needsQuotes)
            {
                return arg;
            }

            var builder = new StringBuilder();
            builder.Append('"');
            var backslashCount = 0;
            for (var i = 0; i < arg.Length; i++)
            {
                var c = arg[i];
                if (c == '\\')
                {
                    backslashCount++;
                    continue;
                }

                if (c == '"')
                {
                    builder.Append('\\', backslashCount * 2 + 1);
                    builder.Append('"');
                }
                else
                {
                    builder.Append('\\', backslashCount);
                    builder.Append(c);
                }
                backslashCount = 0;
            }

            builder.Append('\\', backslashCount * 2);
            builder.Append('"');
            return builder.ToString();
        }
    }
}
