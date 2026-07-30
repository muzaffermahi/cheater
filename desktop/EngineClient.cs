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

    public static async Task<EngineClient> ConnectAsync(CancellationToken cancellationToken = default)
    {
        var name = $"kitten-engine-{Environment.UserName}";
        var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
        await pipe.ConnectAsync(5000, cancellationToken);
        return new EngineClient(pipe);
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
