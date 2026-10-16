using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using Microsoft.Win32;

namespace DocBoxTrans
{
    /// <summary>
    /// 与稻壳阅读器的联动生命周期：
    ///   --watch             隐藏的“守卫”进程：稻壳启动时拉起本工具（会在开机自启里调用）
    ///   --install-autostart 写开机自启 + 立即启动守卫
    ///   --uninstall-autostart 取消开机自启 + 停止守卫
    ///   --stop-watcher      只停止守卫
    ///
    /// 说明：稻壳阅读器是闭源的，无法在它内部挂载启动代码；而仅替换快捷方式/文件关联又会被
    /// “PDF 双击、其它程序调用、重装后关联被覆盖”等路径绕过。因此用一个无界面、无托盘的
    /// 轻量守卫进程（约 1.5 秒轮询一次）来实现可靠的“开稻壳 → 起翻译，关稻壳 → 关翻译”。
    /// </summary>
    static class Lifecycle
    {
        public const string CompanionMutexName = "DocBoxTrans_Companion";
        public const string WatcherMutexName = "DocBoxTrans_Watcher";
        public const string WatcherStopEventName = "DocBoxTrans_Watcher_Stop";
        public const string CompanionExitWithDocBoxEventName = "DocBoxTrans_CompanionExitedWithDocBox";
        const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string RunValueName = "DocBoxTransWatcher";

        // 必须用静态字段持有，否则这些内核对象会被 GC 回收、命名互斥体“凭空消失”
        static Mutex watcherMutex;
        static EventWaitHandle watcherStopEvent;
        static EventWaitHandle companionExitEvent;

        public static string ExePath
        {
            get { return System.Windows.Forms.Application.ExecutablePath; }
        }

        public static string BaseDir
        {
            get { return AppDomain.CurrentDomain.BaseDirectory; }
        }

        // ---------------- 进程/互斥体探测 ----------------

        public static bool IsProcessRunning(string processName)
        {
            try
            {
                Process[] ps = Process.GetProcessesByName(processName);
                bool any = ps.Length > 0;
                for (int i = 0; i < ps.Length; i++) ps[i].Dispose();
                return any;
            }
            catch { return false; }
        }

        /// <summary>
        /// 把该进程名的所有 PID 收进 into（同名进程可能有多个，比如阅读器的辅助进程，
        /// 只记第一个会漏判）。用于让键盘钩子廉价地判断“前台窗口是否属于它”。
        /// </summary>
        public static void CollectProcessIds(string processName, HashSet<int> into)
        {
            into.Clear();
            if (string.IsNullOrEmpty(processName)) return;
            try
            {
                Process[] ps = Process.GetProcessesByName(processName);
                for (int i = 0; i < ps.Length; i++)
                {
                    try { into.Add(ps[i].Id); } catch { }
                    ps[i].Dispose();
                }
            }
            catch { }
        }

        static bool MutexExists(string name)
        {
            try
            {
                using (Mutex m = Mutex.OpenExisting(name)) return true;
            }
            catch (WaitHandleCannotBeOpenedException) { return false; }
            catch (Exception) { return false; }
        }

        public static bool IsCompanionRunning()
        {
            return MutexExists(CompanionMutexName);
        }

        public static bool IsWatcherRunning()
        {
            return MutexExists(WatcherMutexName);
        }

        // ---------------- 开机自启 ----------------

        public static bool IsAutostartEnabled()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKeyPath, false))
                {
                    if (k == null) return false;
                    object v = k.GetValue(RunValueName);
                    return v != null && v.ToString().Length > 0;
                }
            }
            catch { return false; }
        }

        public static string AutostartCommand()
        {
            return "\"" + ExePath + "\" --watch";
        }

        public static bool EnableAutostart()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RunKeyPath))
                {
                    if (k == null) return false;
                    k.SetValue(RunValueName, AutostartCommand(), RegistryValueKind.String);
                }
                WatcherLog("已写入开机自启: " + AutostartCommand());
                return true;
            }
            catch (Exception ex)
            {
                WatcherLog("写开机自启失败: " + ex.Message);
                return false;
            }
        }

        public static bool DisableAutostart()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKeyPath, true))
                {
                    if (k != null && k.GetValue(RunValueName) != null) k.DeleteValue(RunValueName, false);
                }
                WatcherLog("已移除开机自启");
                return true;
            }
            catch (Exception ex)
            {
                WatcherLog("移除开机自启失败: " + ex.Message);
                return false;
            }
        }

        // ---------------- 守卫进程的启动/停止 ----------------

        public static void StartWatcher()
        {
            if (IsWatcherRunning()) return;
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(ExePath);
                psi.Arguments = "--watch";
                psi.WorkingDirectory = BaseDir;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                Process.Start(psi);
            }
            catch (Exception ex) { WatcherLog("启动守卫失败: " + ex.Message); }
        }

        public static void StopWatcher()
        {
            try
            {
                using (EventWaitHandle e = EventWaitHandle.OpenExisting(WatcherStopEventName))
                {
                    e.Set();
                }
            }
            catch { /* 守卫本来就没跑 */ }
        }

        /// <summary>翻译工具因“稻壳已关闭”而主动退出时，用它告知守卫，避免守卫误判成“被用户手动关闭”。</summary>
        public static void SignalExitWithDocBox()
        {
            try
            {
                bool created;
                using (EventWaitHandle e = new EventWaitHandle(false, EventResetMode.ManualReset,
                           CompanionExitWithDocBoxEventName, out created))
                {
                    e.Set();
                }
            }
            catch (Exception ex) { WatcherLog("上报退出原因失败: " + ex.Message); }
        }

        public static int StartCompanion()
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(ExePath);
                psi.WorkingDirectory = BaseDir;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                Process p = Process.Start(psi);
                return p == null ? 0 : p.Id;
            }
            catch (Exception ex)
            {
                WatcherLog("启动翻译工具失败: " + ex.Message);
                return 0;
            }
        }

        static bool ProcessAlive(int pid)
        {
            if (pid <= 0) return false;
            try
            {
                using (Process p = Process.GetProcessById(pid)) return !p.HasExited;
            }
            catch { return false; }
        }

        /// <summary>翻译工具是否在运行：互斥体（手工启动的情况）+ 守卫记录下来的 PID（双保险）。</summary>
        static bool IsCompanionUp(int trackedPid)
        {
            if (MutexExists(CompanionMutexName)) return true;
            return ProcessAlive(trackedPid);
        }

        // ---------------- 守卫主循环 ----------------

        static string ReadDocBoxProcessName()
        {
            try
            {
                AppConfig c = AppConfig.Load(Path.Combine(BaseDir, "config.ini"));
                if (!string.IsNullOrEmpty(c.DocBoxProcess)) return c.DocBoxProcess;
            }
            catch { }
            return "DocBox";
        }

        public static int RunWatcher()
        {
            bool createdNew;
            try { watcherMutex = new Mutex(true, WatcherMutexName, out createdNew); }
            catch (Exception ex) { WatcherLog("创建互斥体失败: " + ex.Message); return 1; }
            if (!createdNew)
            {
                WatcherLog("守卫已在运行，本次启动忽略");
                return 0;
            }

            try
            {
                bool createdEvt;
                watcherStopEvent = new EventWaitHandle(false, EventResetMode.ManualReset, WatcherStopEventName, out createdEvt);
                watcherStopEvent.Reset();
            }
            catch (Exception ex)
            {
                WatcherLog("创建停止事件失败: " + ex.Message);
                return 1;
            }

            try
            {
                bool createdExit;
                companionExitEvent = new EventWaitHandle(false, EventResetMode.ManualReset,
                    CompanionExitWithDocBoxEventName, out createdExit);
            }
            catch (Exception ex)
            {
                WatcherLog("创建“退出原因”事件失败: " + ex.Message);
                return 1;
            }

            string procName = ReadDocBoxProcessName();
            WatcherLog("守卫启动，监视进程: " + procName + "；exe=" + ExePath);

            int companionPid = 0;
            bool prevCompanion = IsCompanionUp(companionPid);
            bool suppressed = false;
            int loop = 0;

            while (true)
            {
                if (watcherStopEvent.WaitOne(1500)) break;   // 每 1.5 秒醒一次，或被显式停止
                loop++;
                if (loop % 20 == 0) procName = ReadDocBoxProcessName();

                bool docbox = IsProcessRunning(procName);
                bool companion = IsCompanionUp(companionPid);

                if (!docbox)
                {
                    suppressed = false;
                    companionPid = 0;
                }

                if (prevCompanion && !companion)
                {
                    if (companionExitEvent.WaitOne(0))
                    {
                        // 它是“因为稻壳关闭”才退出的（正常联动），不是用户手动关闭；
                        // 若此时稻壳又开着，说明用户马上又开了一次，继续正常拉起即可。
                        companionExitEvent.Reset();
                        companionPid = 0;
                        WatcherLog("翻译工具随稻壳关闭而退出");
                    }
                    else if (docbox)
                    {
                        // 稻壳还开着、翻译工具却没了 → 用户手动退出，本次稻壳会话内不再打扰
                        Thread.Sleep(400);
                        if (IsProcessRunning(procName))
                        {
                            suppressed = true;
                            WatcherLog("翻译工具被手动关闭，本次稻壳会话内不再自动启动");
                        }
                        companionPid = 0;
                    }
                }

                if (companion) suppressed = false;

                if (docbox && !companion && !suppressed)
                {
                    WatcherLog("稻壳已启动 → 自动启动翻译工具");
                    companionExitEvent.Reset();   // 新会话开始，清掉可能残留的旧信号
                    companionPid = StartCompanion();
                    Thread.Sleep(1200);
                    companion = IsCompanionUp(companionPid);
                }

                prevCompanion = companion;
            }

            WatcherLog("守卫退出");
            try { watcherStopEvent.Close(); } catch { }
            try { watcherMutex.ReleaseMutex(); } catch { }
            return 0;
        }

        public static void WatcherLog(string msg)
        {
            try
            {
                string p = Path.Combine(BaseDir, "watcher.log");
                FileInfo fi = new FileInfo(p);
                if (fi.Exists && fi.Length > 512 * 1024) File.Delete(p);
                File.AppendAllText(p, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + msg + "\r\n",
                    new UTF8Encoding(false));
            }
            catch { }
        }

        public const string HelpText =
            "DocBox 划词翻译\n\n" +
            "直接双击运行：常驻托盘，在稻壳阅读器里划词后按热键翻译。\n\n" +
            "命令行参数：\n" +
            "  --watch                以隐藏的“守卫”模式运行（负责随稻壳自动启动/关闭翻译工具）\n" +
            "  --install-autostart    开机自启 + 启动守卫（推荐用托盘菜单里的“随稻壳自动启动/关闭”开关）\n" +
            "  --uninstall-autostart  取消开机自启 + 停止守卫\n" +
            "  --stop-watcher         只停止守卫\n" +
            "\n配置界面：运行同目录下的 DocBoxTransConfig.exe，可交互式查看和修改各项配置\n";
    }
}