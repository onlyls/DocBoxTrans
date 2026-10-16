namespace DocBoxTrans
{
    /// <summary>
    /// 配置界面（DocBoxTransConfig.exe）的入口：控制台程序，只用于交互式修改 config.ini。
    /// 与主程序 DocBoxTrans.exe 分开编译，避免把 GUI 程序的控制台输出问题带进来。
    /// </summary>
    static class ConfigCliMain
    {
        [System.STAThread]
        static int Main(string[] args)
        {
            return ConfigCli.Run(args);
        }
    }
}
