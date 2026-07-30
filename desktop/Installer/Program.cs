using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Kitten.Setup;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new SetupForm());
    }
}

internal sealed class SetupForm : Form
{
    private readonly Label _status = new();
    private readonly Button _install = new();
    private readonly ProgressBar _progress = new();
    private readonly string _source = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);

    public SetupForm()
    {
        Text = "Install Kitten";
        Width = 560;
        Height = 250;
        MinimumSize = new Size(560, 250);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;

        var title = new Label { Text = "Kitten", Font = new Font("Segoe UI", 18, FontStyle.Bold), AutoSize = true, Location = new Point(28, 24) };
        var description = new Label { Text = "Install the native desktop coding agent and its private local engine.", AutoSize = true, Location = new Point(30, 64) };
        _status.Text = "Nothing is downloaded. This installer only copies the bundled, verified files.";
        _status.AutoSize = false;
        _status.Width = 490;
        _status.Height = 42;
        _status.Location = new Point(30, 92);
        _progress.Width = 490;
        _progress.Location = new Point(30, 142);
        _progress.Visible = false;
        _install.Text = "Install Kitten";
        _install.AutoSize = true;
        _install.Location = new Point(30, 174);
        _install.Click += (_, _) => Install();

        Controls.AddRange([title, description, _status, _progress, _install]);
    }

    private async void Install()
    {
        _install.Enabled = false;
        _progress.Visible = true;
        try
        {
            var target = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Kitten");
            var files = Directory.EnumerateFiles(_source, "*", SearchOption.AllDirectories)
                .Where(path => !path.StartsWith(target, StringComparison.OrdinalIgnoreCase))
                .ToArray();
            _progress.Maximum = Math.Max(1, files.Length);
            for (var index = 0; index < files.Length; index++)
            {
                var sourcePath = files[index];
                var relative = Path.GetRelativePath(_source, sourcePath);
                var destination = Path.Combine(target, relative);
                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                File.Copy(sourcePath, destination, true);
                _progress.Value = Math.Min(_progress.Maximum, index + 1);
                if (index % 20 == 0) await Task.Yield();
            }
            var executable = Path.Combine(target, "Kitten.Desktop.exe");
            if (!File.Exists(executable)) throw new FileNotFoundException("The desktop executable was missing from the package.", executable);
            CreateShortcut("Kitten", executable, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "Kitten.lnk"));
            _status.Text = "Installed. Starting Kitten...";
            Process.Start(new ProcessStartInfo(executable) { WorkingDirectory = target, UseShellExecute = true });
            Close();
        }
        catch (Exception error)
        {
            _status.Text = $"Installation failed: {error.Message}";
            _progress.Visible = false;
            _install.Enabled = true;
        }
    }

    private static void CreateShortcut(string title, string target, string shortcutPath)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(shortcutPath)!);
        var shellType = Type.GetTypeFromProgID("WScript.Shell") ?? throw new InvalidOperationException("Windows shortcut support is unavailable.");
        dynamic shell = Activator.CreateInstance(shellType)!;
        dynamic shortcut = shell.CreateShortcut(shortcutPath);
        shortcut.TargetPath = target;
        shortcut.WorkingDirectory = Path.GetDirectoryName(target);
        shortcut.Description = title;
        shortcut.Save();
        Marshal.FinalReleaseComObject(shortcut);
        Marshal.FinalReleaseComObject(shell);
    }
}
