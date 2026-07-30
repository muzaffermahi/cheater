using Avalonia;

namespace Kitten.Desktop;

internal static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        using var mutex = new Mutex(true, "Kitten.Desktop.SingleInstance", out var created);
        if (!created) return;
        BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
    }

    public static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace();
}
