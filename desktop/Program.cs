using Avalonia;
using Avalonia.Controls;
using Avalonia.Media.Imaging;
using Avalonia.Threading;

namespace Kitten.Desktop;

internal static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        // A user interface cannot be reviewed by compiling it: a build that succeeds says nothing about
        // whether the window is readable. `--snapshot <file.png>` lays the real window out against the
        // real engine, writes a PNG and exits, so the shell can be inspected during development and
        // pinned in CI. `--palette` captures it with the command palette open.
        var snapshot = ArgValue(args, "--snapshot");
        if (snapshot is not null)
        {
            var delay = ArgValue(args, "--delay") is { } raw && int.TryParse(raw, out var ms) ? ms : 2500;
            RunSnapshot(snapshot, delay, HasFlag(args, "--palette"));
            return;
        }

        using var mutex = new Mutex(true, "Kitten.Desktop.SingleInstance", out var created);
        if (!created) return;
        BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
    }

    private static string? ArgValue(string[] args, string name)
    {
        var index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    private static bool HasFlag(string[] args, string name) => Array.IndexOf(args, name) >= 0;

    private static void RunSnapshot(string path, int delayMs, bool withPalette)
    {
        BuildAvaloniaApp().Start((_, _) =>
        {
            var window = new MainWindow();
            window.Show();
            DispatcherTimer.RunOnce(() =>
            {
                try
                {
                    if (withPalette) window.OpenPaletteForSnapshot();
                    // A second beat lets the palette's own layout settle before the frame is captured.
                    DispatcherTimer.RunOnce(() =>
                    {
                        try { Capture(window, path); }
                        catch (Exception error) { Console.Error.WriteLine($"snapshot failed: {error.Message}"); }
                        window.Close();
                        Dispatcher.UIThread.InvokeShutdown();
                    }, TimeSpan.FromMilliseconds(withPalette ? 400 : 1));
                }
                catch (Exception error)
                {
                    Console.Error.WriteLine($"snapshot failed: {error.Message}");
                    Dispatcher.UIThread.InvokeShutdown();
                }
            }, TimeSpan.FromMilliseconds(Math.Max(0, delayMs)));
            Dispatcher.UIThread.MainLoop(CancellationToken.None);
        }, Array.Empty<string>());
    }

    private static void Capture(Window window, string path)
    {
        var width = (int)Math.Round(window.Bounds.Width > 0 ? window.Bounds.Width : window.Width);
        var height = (int)Math.Round(window.Bounds.Height > 0 ? window.Bounds.Height : window.Height);
        using var bitmap = new RenderTargetBitmap(new PixelSize(Math.Max(1, width), Math.Max(1, height)), new Vector(96, 96));
        bitmap.Render(window);
        var full = Path.GetFullPath(path);
        var directory = Path.GetDirectoryName(full);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        bitmap.Save(full);
        Console.WriteLine($"snapshot written: {full} ({width}x{height})");
    }

    public static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace();
}
