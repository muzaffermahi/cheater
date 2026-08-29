using System.Buffers.Binary;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace Kitten.Desktop;

public sealed class EngineClient : IAsyncDisposable
{
    private readonly NamedPipeClientStream _pipe;
    private readonly CancellationTokenSource _shutdown = new();
    private readonly Dictionary<string, TaskCompletionSource<JsonElement?>> _pending = new();
    private readonly object _gate = new();
    private readonly SemaphoreSlim _writeGate = new(1, 1);
    private int _nextId;
    private readonly Task _reader;

    public event Action<JsonElement>? EventReceived;
    public event Action<Exception?>? Disconnected;

    private EngineClient(NamedPipeClientStream pipe)
    {
        _pipe = pipe;
        _reader = Task.Run(ReadLoopAsync);
    }

    /// <summary>
    /// The engine publishes its socket path and a per-launch handshake token to
    /// &lt;kitten home&gt;/engine.json when it starts. The engine serves nothing at all — not liveness,
    /// and never its event stream — until that token is presented, so another local process cannot
    /// drive the agent or read this session's prompts, code and diffs.
    /// </summary>
    private sealed record EngineInfo(string SocketPath, string Token);

    public static string InfoPath()
    {
        var home = Environment.GetEnvironmentVariable("KITTEN_HOME");
        if (string.IsNullOrWhiteSpace(home)) home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".kitten");
        return Path.Combine(home, "engine.json");
    }

    /// <summary>
    /// The engine's published connection details, or null if there is no LIVE engine to connect to.
    ///
    /// The liveness check is the point. An engine that dies without running its cleanup leaves this
    /// file behind, and a stale file is worse than a missing one: the shell reads the dead engine's
    /// token immediately, skips waiting for the new engine to publish its own, and then presents the
    /// wrong secret the moment the new pipe appears. The user sees
    /// "engine handshake token is invalid" — a security-shaped message for what is really a leftover
    /// file. Treating a dead engine's file as absent makes the connect loop wait for the real one.
    /// </summary>
    private static EngineInfo? ReadInfo()
    {
        try
        {
            var path = InfoPath();
            if (!File.Exists(path)) return null;
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            var root = document.RootElement;
            var socketPath = root.TryGetProperty("socketPath", out var s) ? s.GetString() : null;
            var token = root.TryGetProperty("token", out var t) ? t.GetString() : null;
            if (string.IsNullOrWhiteSpace(socketPath) || string.IsNullOrWhiteSpace(token)) return null;
            var pid = root.TryGetProperty("pid", out var p) && p.ValueKind == JsonValueKind.Number ? p.GetInt32() : 0;
            if (pid > 0 && !IsProcessAlive(pid)) return null;
            return new EngineInfo(socketPath!, token!);
        }
        catch { return null; }
    }

    private static bool IsProcessAlive(int pid)
    {
        try
        {
            using var process = System.Diagnostics.Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch { return false; }
    }

    /// <summary>Remove a token file whose engine is gone, so nothing can read it during the next start.</summary>
    public static void ClearStaleInfo()
    {
        try
        {
            var path = InfoPath();
            if (!File.Exists(path)) return;
            if (ReadInfo() is null) File.Delete(path);
        }
        catch { /* a live engine overwrites it anyway */ }
    }

    private static string PipeName(string socketPath)
    {
        const string prefix = @"\\.\pipe\";
        return socketPath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ? socketPath.Substring(prefix.Length) : socketPath;
    }

    public static async Task<EngineClient> ConnectAsync(CancellationToken cancellationToken = default)
    {
        // The engine writes its info file only once it owns the socket, so waiting for the file is
        // also how the shell waits for a ready engine.
        var deadline = DateTime.UtcNow.AddSeconds(15);
        Exception? last = null;
        while (DateTime.UtcNow < deadline)
        {
            var info = ReadInfo();
            if (info is null)
            {
                await Task.Delay(150, cancellationToken);
                continue;
            }
            try { return await HandshakeAsync(info, cancellationToken); }
            catch (OperationCanceledException) { throw; }
            catch (Exception error)
            {
                // A rejected token is a RACE, not a verdict: the engine restarts and publishes a new
                // secret, and a connection begun a moment earlier is holding the old one. Re-read and
                // try again until the deadline instead of ending the session on it.
                last = error;
                await Task.Delay(200, cancellationToken);
            }
        }
        throw last ?? new TimeoutException("The Kitten engine did not publish its local connection details.");
    }

    private static async Task<EngineClient> HandshakeAsync(EngineInfo info, CancellationToken cancellationToken)
    {
        var pipe = new NamedPipeClientStream(".", PipeName(info.SocketPath), PipeDirection.InOut, PipeOptions.Asynchronous);
        await pipe.ConnectAsync(5000, cancellationToken);
        var client = new EngineClient(pipe);
        try
        {
            var hello = await client.CallAsync("hello", new { token = info.Token }, cancellationToken);
            if (hello is null || !hello.Value.TryGetProperty("authenticated", out var ok) || !ok.GetBoolean())
            {
                throw new InvalidOperationException("The Kitten engine rejected this session's handshake.");
            }
            return client;
        }
        catch
        {
            await client.DisposeAsync();
            throw;
        }
    }

    public async Task<JsonElement?> CallAsync(string type, object? payload = null, CancellationToken cancellationToken = default)
    {
        var id = Interlocked.Increment(ref _nextId).ToString();
        var request = JsonSerializer.SerializeToUtf8Bytes(new { protocolVersion = 1, id, type, payload });
        var completion = new TaskCompletionSource<JsonElement?>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (_gate) _pending[id] = completion;
        try
        {
            await _writeGate.WaitAsync(cancellationToken);
            try { await WriteFrameAsync(request, cancellationToken); }
            finally { _writeGate.Release(); }
            using var registration = cancellationToken.Register(() => completion.TrySetCanceled(cancellationToken));
            return await completion.Task;
        }
        finally
        {
            lock (_gate) _pending.Remove(id);
        }
    }

    private async Task ReadLoopAsync()
    {
        try
        {
            while (!_shutdown.IsCancellationRequested)
            {
                var bytes = await ReadFrameAsync(_shutdown.Token);
                using var doc = JsonDocument.Parse(bytes);
                var root = doc.RootElement.Clone();
                if (root.TryGetProperty("eventId", out _))
                {
                    try { EventReceived?.Invoke(root); } catch { /* UI observers must not kill the transport */ }
                    continue;
                }
                if (!root.TryGetProperty("id", out var responseId)) continue;
                var id = responseId.GetString() ?? "";
                TaskCompletionSource<JsonElement?>? completion;
                lock (_gate) _pending.TryGetValue(id, out completion);
                if (completion is null) continue;
                if (root.TryGetProperty("ok", out var ok) && ok.GetBoolean() && root.TryGetProperty("result", out var result)) completion.TrySetResult(result.Clone());
                else completion.TrySetException(new InvalidOperationException(root.TryGetProperty("error", out var error) ? error.ToString() : "Engine command failed"));
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception error)
        {
            TaskCompletionSource<JsonElement?>[] pending;
            lock (_gate) pending = _pending.Values.ToArray();
            foreach (var completion in pending) completion.TrySetException(error);
            if (!_shutdown.IsCancellationRequested)
            {
                try { Disconnected?.Invoke(error); } catch { /* observers cannot revive the reader */ }
            }
        }
    }

    private async Task WriteFrameAsync(byte[] body, CancellationToken cancellationToken)
    {
        var header = new byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(header, (uint)body.Length);
        await _pipe.WriteAsync(header, cancellationToken);
        await _pipe.WriteAsync(body, cancellationToken);
        await _pipe.FlushAsync(cancellationToken);
    }

    private async Task<byte[]> ReadFrameAsync(CancellationToken cancellationToken)
    {
        var header = new byte[4];
        await ReadExactlyAsync(header, cancellationToken);
        var length = BinaryPrimitives.ReadUInt32BigEndian(header);
        if (length == 0 || length > 8 * 1024 * 1024) throw new InvalidDataException("Invalid engine frame length");
        var body = new byte[length];
        await ReadExactlyAsync(body, cancellationToken);
        return body;
    }

    private async Task ReadExactlyAsync(byte[] buffer, CancellationToken cancellationToken)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = await _pipe.ReadAsync(buffer.AsMemory(offset), cancellationToken);
            if (read == 0) throw new EndOfStreamException("Engine disconnected");
            offset += read;
        }
    }

    public async ValueTask DisposeAsync()
    {
        _shutdown.Cancel();
        _pipe.Dispose();
        try { await _reader; } catch { }
        TaskCompletionSource<JsonElement?>[] pending;
        lock (_gate) pending = _pending.Values.ToArray();
        foreach (var completion in pending) completion.TrySetCanceled();
        _writeGate.Dispose();
        _shutdown.Dispose();
    }
}
