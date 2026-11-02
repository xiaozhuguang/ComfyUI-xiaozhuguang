using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class Launcher
{
    [STAThread]
    private static int Main(string[] args)
    {
        bool validate = args.Length == 1 && args[0] == "--validate-only";
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string script = Path.Combine(root, "installer", "install.ps1");
            if (!File.Exists(script))
                throw new FileNotFoundException("找不到 installer\\install.ps1，请将安装器与完整插件放在一起。", script);
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
                "WindowsPowerShell", "v1.0", "powershell.exe");
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = powershell;
            start.Arguments = "-NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File \"" + script + "\"" +
                (validate ? " -ValidateOnly" : "");
            start.WorkingDirectory = root;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            using (Process child = Process.Start(start))
            {
                child.WaitForExit();
                if (child.ExitCode != 0 && !validate)
                    MessageBox.Show("安装界面启动失败，请检查 installer 文件夹是否完整。", "小珠光安装器",
                        MessageBoxButtons.OK, MessageBoxIcon.Error);
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            if (!validate)
                MessageBox.Show(error.Message, "小珠光安装器", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
