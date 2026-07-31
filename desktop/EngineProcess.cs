using System.Diagnostics;

namespace Kitten.Desktop;

public sealed class EngineProcess : IDisposable
{
    private Process? _process;

    public void Start(string? projectRoot = null)
    {
        if (_process is { HasExited: false }) return;
        var engineRoot = Path.Combine(AppContext.BaseDirectory, "engine");
        var executable = Path.Combine(engineRoot, "kitten-desktop-engine.exe");
        var info = File.Exists(executable)
            ? new ProcessStartInfo(executable)
            : BuildNodeEngineStartInfo(engineRoot);
        if (info is null) throw new FileNotFoundException("Kitten engine is missing from the installation.", executable);
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.WindowStyle = ProcessWindowStyle.Hidden;
        info.WorkingDirectory = projectRoot ?? Environment.CurrentDirectory;
        info.ArgumentList.Add("--parent-pid");
        info.ArgumentList.Add(Environment.ProcessId.ToString());
        if (!string.IsNullOrWhiteSpace(projectRoot)) info.ArgumentList.Add("--project-root");
        if (!string.IsNullOrWhiteSpace(projectRoot)) info.ArgumentList.Add(projectRoot);
        _process = Process.Start(info) ?? throw new InvalidOperationException("Kitten engine could not start.");
    }

    private static ProcessStartInfo? BuildNodeEngineStartInfo(string engineRoot)
    {
        var script = Path.Combine(engineRoot, "desktopEngine.js");
        if (!File.Exists(script)) script = Path.Combine(engineRoot, "dist", "src", "core", "desktopEngine.js");
        if (!File.Exists(script)) return null;
        var bundledNode = Path.Combine(engineRoot, "node.exe");
        var node = File.Exists(bundledNode) ? bundledNode : "node";
        var info = new ProcessStartInfo(node);
        info.ArgumentList.Add(script);
        return info;
    }

    public void Dispose()
    {
        try
        {
            if (_process is { HasExited: false }) _process.Kill(entireProcessTree: true);
        }
        catch { /* shutdown is best effort */ }
        _process?.Dispose();
        _process = null;
    }
}
