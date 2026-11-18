param(
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$ChildCommandLine,
  [Parameter(Mandatory=$true)][string]$WorkingDirectory,
  [Parameter(Mandatory=$true)][string]$LogFile,
  [Parameter(Mandatory=$true)][int]$OwnerPid,
  [int]$TimeoutMs = 300000
)
$ErrorActionPreference = 'Stop'

# A separate Windows desktop keeps even explicit Electron show/focus calls off
# the user's desktop. Never switch to it. Closing the job kills all descendants.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class HiddenTestDesktop {
  [StructLayout(LayoutKind.Sequential)] struct Security {
    public int Length; public IntPtr Descriptor; public int Inherit;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int Size; public string Reserved, Desktop, Title;
    public int X,Y,Width,Height,CharsX,CharsY,Fill,Flags;
    public short Show,ReservedSize; public IntPtr ReservedBytes,Input,Output,Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process,Thread; public int ProcessId,ThreadId;
  }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long ProcessTime,JobTime; public uint Flags;
    public UIntPtr MinWorkingSet,MaxWorkingSet; public uint ActiveProcesses;
    public UIntPtr Affinity; public uint Priority,Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
    public BasicLimit Basic; public IoCounters Io;
    public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;
  }
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateDesktop(string name,IntPtr device,IntPtr mode,int flags,uint access,IntPtr security);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimit info,int length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string name,uint access,uint share,ref Security security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string exe,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string cwd,ref Startup startup,out ProcessInfo info);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static int Run(string exe,string command,string cwd,string log,int ownerPid,int timeout) {
    IntPtr desktop=IntPtr.Zero,job=IntPtr.Zero,output=IntPtr.Zero,input=IntPtr.Zero;
    ProcessInfo child=new ProcessInfo(); bool assigned=false;
    try {
      using(Process owner=Process.GetProcessById(ownerPid)) {
        string name="BaoyiTest-"+Guid.NewGuid().ToString("N");
        desktop=CreateDesktop(name,IntPtr.Zero,IntPtr.Zero,0,0x01FF,IntPtr.Zero);Check(desktop!=IntPtr.Zero);
        job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero);
        ExtendedLimit limits=new ExtendedLimit();limits.Basic.Flags=0x2000;
        Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(ExtendedLimit))));
        Security security=new Security{Length=Marshal.SizeOf(typeof(Security)),Inherit=1};
        output=CreateFile(log,0x40000000,3,ref security,2,0x80,IntPtr.Zero);Check(output!=new IntPtr(-1));
        input=CreateFile("NUL",0x80000000,3,ref security,3,0x80,IntPtr.Zero);Check(input!=new IntPtr(-1));
        Startup startup=new Startup{Size=Marshal.SizeOf(typeof(Startup)),Desktop=name,Flags=0x101,Show=0,Input=input,Output=output,Error=output};
        Check(CreateProcess(exe,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,cwd,ref startup,out child));
        Check(AssignProcessToJobObject(job,child.Process));assigned=true;
        Check(ResumeThread(child.Thread)!=0xffffffff);
        Console.WriteLine("Hidden test desktop: "+name);
        Stopwatch elapsed=Stopwatch.StartNew();
        while(true) {
          uint state=WaitForSingleObject(child.Process,200);
          if(state==0) { uint code;Check(GetExitCodeProcess(child.Process,out code));return unchecked((int)code); }
          Check(state==258);
          if(owner.HasExited) return 130;
          if(elapsed.ElapsedMilliseconds>=timeout) return 124;
        }
      }
    } finally {
      if(child.Process!=IntPtr.Zero&&!assigned) TerminateProcess(child.Process,130);
      if(job!=IntPtr.Zero) CloseHandle(job);
      if(child.Thread!=IntPtr.Zero) CloseHandle(child.Thread);
      if(child.Process!=IntPtr.Zero) CloseHandle(child.Process);
      if(input!=IntPtr.Zero&&input!=new IntPtr(-1)) CloseHandle(input);
      if(output!=IntPtr.Zero&&output!=new IntPtr(-1)) CloseHandle(output);
      if(desktop!=IntPtr.Zero) CloseDesktop(desktop);
    }
  }
}
'@
exit [HiddenTestDesktop]::Run($Executable, $ChildCommandLine, $WorkingDirectory, $LogFile, $OwnerPid, $TimeoutMs)
