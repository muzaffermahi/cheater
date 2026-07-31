using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Kitten.Setup;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var quiet = args.Contains("--quiet", StringComparer.OrdinalIgnoreCase);
        if (args.Contains("--uninstall", StringComparer.OrdinalIgnoreCase))
        {
            Uninstaller.Run(quiet);
            return;
        }
        // Self-deletion relay: the copy in %TEMP% removes the install directory the original ran from.
        var fromIndex = Array.FindIndex(args, arg => string.Equals(arg, "--uninstall-from", StringComparison.OrdinalIgnoreCase));
        if (fromIndex >= 0 && fromIndex + 1 < args.Length)
        {
            Uninstaller.RemoveDirectory(args[fromIndex + 1], quiet);
            return;
        }
        Application.Run(new SetupForm());
    }
}

internal static class InstallInfo
{
    public const string RegistryKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Kitten";

    public static string TargetDirectory => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Kitten");
    public static string StartMenuShortcut => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "Kitten.lnk");
    public static string DesktopShortcut => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Kitten.lnk");

    public static bool IsInstalled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RegistryKey);
        return key is not null;
    }

    /// <summary>Version from release.json beside the installer; a dev bundle honestly says so.</summary>
    public static string BundleVersion(string source)
    {
        try
        {
            var releasePath = Path.Combine(source, "release.json");
            if (File.Exists(releasePath))
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(releasePath));
                if (doc.RootElement.TryGetProperty("version", out var version) && version.ValueKind == JsonValueKind.String)
                    return version.GetString() ?? "0.0.0-dev";
            }
        }
        catch { /* fall through */ }
        return "0.0.0-dev";
    }
}

internal sealed class SetupForm : Form
{
    private readonly Label _status = new();
    private readonly Button _install = new();
    private readonly ProgressBar _progress = new();
    private readonly string _source = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    private readonly string _version;

    public SetupForm()
    {
        _version = InstallInfo.BundleVersion(_source);
        Text = $"Install Kitten {_version}";
        Width = 560;
        Height = 250;
        MinimumSize = new Size(560, 250);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        try { Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { /* generic icon is fine */ }

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
        _install.Text = InstallInfo.IsInstalled() ? "Update Kitten" : "Install Kitten";
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
            // Running straight out of a zip preview extracts only this exe — the payload is missing.
            if (!File.Exists(Path.Combine(_source, "Kitten.Desktop.exe")))
                throw new FileNotFoundException("The install payload is missing. Extract the full Kitten zip to a folder first, then run Kitten.Setup.exe from there.");

            var target = InstallInfo.TargetDirectory;
            var files = Directory.EnumerateFiles(_source, "*", SearchOption.AllDirectories)
                .Where(path => !path.StartsWith(target, StringComparison.OrdinalIgnoreCase))
                .ToArray();
            _progress.Maximum = Math.Max(1, files.Length);
            long copiedBytes = 0;
            for (var index = 0; index < files.Length; index++)
            {
                var sourcePath = files[index];
                var relative = Path.GetRelativePath(_source, sourcePath);
                var destination = Path.Combine(target, relative);
                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                File.Copy(sourcePath, destination, true);
                copiedBytes += new FileInfo(sourcePath).Length;
                _progress.Value = Math.Min(_progress.Maximum, index + 1);
                if (index % 20 == 0) await Task.Yield();
            }
            var executable = Path.Combine(target, "Kitten.Desktop.exe");
            if (!File.Exists(executable)) throw new FileNotFoundException("The desktop executable was missing from the package.", executable);

            // Both shortcuts carry the app's own icon: the Start Menu for search, the Desktop for the
            // one-click open the product promises.
            CreateShortcut("Kitten", executable, InstallInfo.StartMenuShortcut);
            CreateShortcut("Kitten", executable, InstallInfo.DesktopShortcut);
            WriteUninstallRegistry(target, executable, copiedBytes);

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

    /// <summary>The Add/Remove Programs entry (HKCU — a per-user install needs no elevation).</summary>
    private void WriteUninstallRegistry(string target, string executable, long copiedBytes)
    {
        using var key = Registry.CurrentUser.CreateSubKey(InstallInfo.RegistryKey);
        key.SetValue("DisplayName", "Kitten");
        key.SetValue("DisplayVersion", _version);
        key.SetValue("Publisher", "Kitten");
        key.SetValue("InstallLocation", target);
        key.SetValue("DisplayIcon", $"{executable},0");
        key.SetValue("UninstallString", $"\"{Path.Combine(target, "Kitten.Setup.exe")}\" --uninstall");
        key.SetValue("QuietUninstallString", $"\"{Path.Combine(target, "Kitten.Setup.exe")}\" --uninstall --quiet");
        key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
        key.SetValue("NoModify", 1, RegistryValueKind.DWord);
        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        key.SetValue("EstimatedSize", (int)Math.Min(int.MaxValue, copiedBytes / 1024), RegistryValueKind.DWord);
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
        shortcut.IconLocation = $"{target},0";
        shortcut.Save();
        Marshal.FinalReleaseComObject(shortcut);
        Marshal.FinalReleaseComObject(shell);
    }
}

internal static class Uninstaller
{
    public static void Run(bool quiet)
    {
        var target = InstallInfo.TargetDirectory;
        using (var key = Registry.CurrentUser.OpenSubKey(InstallInfo.RegistryKey))
        {
            if (key?.GetValue("InstallLocation") is string location && Directory.Exists(location)) target = location;
        }

        if (!quiet)
        {
            var answer = MessageBox.Show(
                $"Remove Kitten from this computer?\n\nThis deletes {target} and the shortcuts.\nYour conversations and settings (~/.kitten) are kept.",
                "Uninstall Kitten", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (answer != DialogResult.Yes) return;
        }

        // A running Kitten holds the very files being deleted.
        try
        {
            if (Mutex.TryOpenExisting("Kitten.Desktop.SingleInstance", out var running))
            {
                running.Dispose();
                if (!quiet) MessageBox.Show("Close Kitten first, then run the uninstaller again.", "Kitten is running", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
        }
        catch { /* not running */ }

        TryDelete(InstallInfo.StartMenuShortcut);
        TryDelete(InstallInfo.DesktopShortcut);
        try { Registry.CurrentUser.DeleteSubKeyTree(InstallInfo.RegistryKey, throwOnMissingSubKey: false); } catch { /* best effort */ }

        // Self-deletion: this exe lives inside the directory being removed, so a temp copy finishes
        // the job. The temp copy is left for the OS temp cleaner.
        try
        {
            var self = Application.ExecutablePath;
            if (self.StartsWith(target, StringComparison.OrdinalIgnoreCase))
            {
                var relay = Path.Combine(Path.GetTempPath(), $"KittenUninstall-{Environment.ProcessId}.exe");
                File.Copy(self, relay, true);
                Process.Start(new ProcessStartInfo(relay) { ArgumentList = { "--uninstall-from", target, "--quiet" }, UseShellExecute = false });
                return;
            }
        }
        catch { /* fall through to a direct attempt */ }
        RemoveDirectory(target, quiet);
    }

    public static void RemoveDirectory(string target, bool quiet)
    {
        // The original process may still be exiting; give its file handles a moment.
        for (var attempt = 0; attempt < 10; attempt++)
        {
            try
            {
                if (Directory.Exists(target)) Directory.Delete(target, recursive: true);
                if (!quiet) MessageBox.Show("Kitten was removed. Your conversations and settings (~/.kitten) were kept.", "Uninstalled", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            catch
            {
                Thread.Sleep(400);
            }
        }
        if (!quiet) MessageBox.Show($"Some files could not be removed. Delete {target} manually.", "Uninstall incomplete", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { /* best effort */ }
    }
}
