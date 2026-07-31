using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using System.Diagnostics;

namespace Kitten.Desktop;

/// <summary>
/// The conversation surface. This used to be one flat <c>TextBlock</c> whose contents were built with
/// string concatenation, so a run's user prompt, the model's prose, its code, and the harness's own
/// receipts arrived as one undifferentiated wall of text — you could not tell who said what, code was
/// unreadable in a proportional font, and nothing was selectable per message.
///
/// Each turn is now its own card: a role header plus a body split into prose and fenced code blocks.
/// Code renders monospaced on its own surface. Kitten's own notes (plans, subagent reports, postflight)
/// are marked as harness output rather than being mistaken for model prose — an honesty requirement,
/// not decoration.
/// </summary>
public sealed class TranscriptView
{
    private readonly Panel _host;
    private readonly ScrollViewer _scroll;
    private SelectableTextBlock? _streamingBody;
    private Panel? _streamingCard;
    private string _streamingText = "";
    private bool _thinking;
    private Border? _streamingBorder;

    /// <summary>Live tool cards keyed by callId: a spinner while running, swapped for ✓/✗ on completion.</summary>
    private sealed class ToolCardHandle
    {
        public required Border Card;
        public required StackPanel Step;
        public required TextBlock Mark;
        public required TextBlock Elapsed;
        public SelectableTextBlock? Preview;
        public readonly Stopwatch Watch = Stopwatch.StartNew();
        public readonly System.Text.StringBuilder Tail = new();
    }

    private readonly Dictionary<string, ToolCardHandle> _openTools = new(StringComparer.Ordinal);
    private DispatcherTimer? _spinnerTimer;
    private int _spinnerFrame;
    private static readonly string[] SpinnerGlyphs = { "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧" };

    private static readonly FontFamily Mono = new("Cascadia Mono,Consolas,Menlo,monospace");
    private static readonly IBrush Text = new SolidColorBrush(Color.Parse("#e8e8ec"));
    private static readonly IBrush Muted = new SolidColorBrush(Color.Parse("#9a9aa4"));
    private static readonly IBrush Faint = new SolidColorBrush(Color.Parse("#6a6a74"));
    private static readonly IBrush Ok = new SolidColorBrush(Color.Parse("#6ee7a8"));
    private static readonly IBrush Err = new SolidColorBrush(Color.Parse("#f4837f"));
    private static readonly IBrush ToolBackground = new SolidColorBrush(Color.Parse("#101014"));

    public TranscriptView(Panel host, ScrollViewer scroll)
    {
        _host = host;
        _scroll = scroll;
    }

    public enum Role { User, Assistant, Note, Tool, System }

    /// <summary>
    /// One tool call, rendered as a compact step rather than a card. Seeing which files the agent read,
    /// what it edited and which command it ran is the main thing a coding agent has to show; before
    /// this, tool activity only ever appeared as a transient "Using bash" status and was dropped
    /// entirely from replayed history.
    /// </summary>
    public void AddTool(string name, bool ok, long durationMs, string output) => AddTool(name, "", ok, durationMs, output);

    /// <summary>
    /// Open a LIVE tool card: spinner + elapsed time while the call runs, streaming output preview as
    /// chunks arrive, resolved to ✓/✗ by <see cref="CompleteTool"/>. This is what "what is it doing
    /// right now" looks like in the transcript — before this, a card only materialised after the fact.
    /// </summary>
    public void BeginTool(string callId, string name, string target)
    {
        if (IsStreaming) CompleteAssistant();
        var step = new StackPanel { Spacing = 3 };
        var head = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        var mark = new TextBlock { Text = SpinnerGlyphs[0], Foreground = Muted, FontSize = 12, VerticalAlignment = VerticalAlignment.Center, FontFamily = Mono };
        head.Children.Add(mark);
        head.Children.Add(new TextBlock { Text = name, FontFamily = Mono, FontSize = 12.5, Foreground = Text, VerticalAlignment = VerticalAlignment.Center });
        if (!string.IsNullOrWhiteSpace(target))
        {
            head.Children.Add(new TextBlock { Text = target.Length > 90 ? target[..90] + "…" : target, FontFamily = Mono, FontSize = 12, Foreground = Muted, VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis });
        }
        var elapsed = new TextBlock { Text = "", FontSize = 11.5, Foreground = Faint, VerticalAlignment = VerticalAlignment.Center };
        head.Children.Add(elapsed);
        step.Children.Add(head);
        var card = new Border { Child = step, Padding = new Thickness(12, 6), Margin = new Thickness(0, 0, 0, 6), CornerRadius = new CornerRadius(6), Background = ToolBackground };
        _host.Children.Add(card);
        _openTools[callId] = new ToolCardHandle { Card = card, Step = step, Mark = mark, Elapsed = elapsed };
        EnsureSpinner();
        ScrollToEnd();
    }

    /// <summary>Append a bounded live output chunk to an open tool card's preview.</summary>
    public void AppendToolOutput(string callId, string chunk)
    {
        if (!_openTools.TryGetValue(callId, out var handle) || string.IsNullOrEmpty(chunk)) return;
        handle.Tail.Append(chunk);
        if (handle.Tail.Length > 4000) handle.Tail.Remove(0, handle.Tail.Length - 4000);
        var preview = FirstLines(TailLines(handle.Tail.ToString(), 2), 2);
        if (preview.Length == 0) return;
        if (handle.Preview is null)
        {
            handle.Preview = new SelectableTextBlock { FontFamily = Mono, FontSize = 11.5, Foreground = Muted, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(20, 0, 0, 0) };
            handle.Step.Children.Add(handle.Preview);
        }
        handle.Preview.Text = preview;
        ScrollToEnd();
    }

    /// <summary>
    /// Resolve a live card: ✓/✗ + real duration; on failure the salient error line lands in error
    /// colour above the muted preview (never raw JSON, never nothing). Returns false when the callId
    /// was never opened — the caller then falls back to the classic AddTool path (which is also the
    /// history-replay path, so old sessions render identically).
    /// </summary>
    public bool CompleteTool(string callId, bool ok, long durationMs, string output)
    {
        if (!_openTools.TryGetValue(callId, out var handle)) return false;
        _openTools.Remove(callId);
        if (_openTools.Count == 0) StopSpinner();
        handle.Mark.Text = ok ? "✓" : "✗";
        handle.Mark.Foreground = ok ? Ok : Err;
        var ms = durationMs > 0 ? durationMs : handle.Watch.ElapsedMilliseconds;
        handle.Elapsed.Text = ms >= 1000 ? $"{ms / 1000.0:0.0}s" : $"{ms}ms";
        // Rebuild the body from the authoritative final output (streamed chunks were a preview only).
        if (handle.Preview is not null) handle.Step.Children.Remove(handle.Preview);
        if (!ok)
        {
            var salient = SalientErrorLine(output);
            if (salient.Length > 0) handle.Step.Children.Add(new SelectableTextBlock { Text = salient, FontFamily = Mono, FontSize = 12, Foreground = Err, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(20, 0, 0, 0) });
        }
        var detail = FirstLines(output, 2);
        if (detail.Length > 0) handle.Step.Children.Add(new SelectableTextBlock { Text = detail, FontFamily = Mono, FontSize = 11.5, Foreground = Muted, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(20, 0, 0, 0) });
        ScrollToEnd();
        return true;
    }

    /// <summary>Resolve every still-open card (a cancelled/failed run must not leave spinners forever).</summary>
    public void AbandonOpenTools()
    {
        foreach (var handle in _openTools.Values)
        {
            handle.Mark.Text = "✗";
            handle.Mark.Foreground = Err;
            handle.Elapsed.Text = "stopped";
        }
        _openTools.Clear();
        StopSpinner();
    }

    /// <summary>The first line that looks like the actual error, else the last non-empty line.</summary>
    private static string SalientErrorLine(string output)
    {
        var lines = (output ?? "").Replace("\r\n", "\n").Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0).ToList();
        var salient = lines.FirstOrDefault(l => System.Text.RegularExpressions.Regex.IsMatch(l, "error|exception|failed|fatal|traceback|denied|refused", System.Text.RegularExpressions.RegexOptions.IgnoreCase) && !l.StartsWith("$ ", StringComparison.Ordinal))
            ?? (lines.Count > 0 && !lines[^1].StartsWith("[", StringComparison.Ordinal) ? lines[^1] : lines.FirstOrDefault(l => !l.StartsWith("$ ", StringComparison.Ordinal)) ?? "");
        return salient.Length > 220 ? salient[..220] + "…" : salient;
    }

    private static string TailLines(string text, int count)
    {
        var lines = text.Replace("\r\n", "\n").Split('\n').Where(l => l.Trim().Length > 0).ToList();
        return string.Join("\n", lines.TakeLast(count));
    }

    /// <summary>One shared spinner timer across every open card; stopped the moment none remain.</summary>
    private void EnsureSpinner()
    {
        if (_spinnerTimer is not null) return;
        _spinnerTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(120) };
        _spinnerTimer.Tick += (_, _) =>
        {
            _spinnerFrame = (_spinnerFrame + 1) % SpinnerGlyphs.Length;
            foreach (var handle in _openTools.Values)
            {
                handle.Mark.Text = SpinnerGlyphs[_spinnerFrame];
                var ms = handle.Watch.ElapsedMilliseconds;
                handle.Elapsed.Text = ms >= 1000 ? $"{ms / 1000.0:0.0}s" : "";
            }
        };
        _spinnerTimer.Start();
    }

    private void StopSpinner()
    {
        _spinnerTimer?.Stop();
        _spinnerTimer = null;
    }

    public void AddTool(string name, string target, bool ok, long durationMs, string output)
    {
        // Tools run inside a turn, so close the prose card first: the reader then sees what the model
        // said, what it then did, and what it said next, in the order it happened.
        if (IsStreaming) CompleteAssistant();
        var step = new StackPanel { Spacing = 3 };
        var head = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        head.Children.Add(new TextBlock { Text = ok ? "✓" : "✗", Foreground = ok ? Ok : Err, FontSize = 12, VerticalAlignment = VerticalAlignment.Center });
        head.Children.Add(new TextBlock { Text = name, FontFamily = Mono, FontSize = 12.5, Foreground = Text, VerticalAlignment = VerticalAlignment.Center });
        var detailText = FirstLines(output, 2);
        // A shell tool's output already opens with `$ <command>`, so repeating the command as the target
        // would print it twice.
        if (detailText.StartsWith("$ ", StringComparison.Ordinal) && !string.IsNullOrWhiteSpace(target) && detailText.Contains(target.TrimEnd('…'), StringComparison.Ordinal)) target = "";
        if (!string.IsNullOrWhiteSpace(target))
        {
            head.Children.Add(new TextBlock { Text = target.Length > 90 ? target.Substring(0, 90) + "…" : target, FontFamily = Mono, FontSize = 12, Foreground = Muted, VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis });
        }
        if (durationMs > 0) head.Children.Add(new TextBlock { Text = durationMs >= 1000 ? $"{durationMs / 1000.0:0.0}s" : $"{durationMs}ms", FontSize = 11.5, Foreground = Faint, VerticalAlignment = VerticalAlignment.Center });
        step.Children.Add(head);
        // A failed call leads with the line that actually says why — not two lines of restated command.
        if (!ok)
        {
            var salient = SalientErrorLine(output);
            if (salient.Length > 0 && !detailText.Contains(salient, StringComparison.Ordinal)) step.Children.Add(new SelectableTextBlock { Text = salient, FontFamily = Mono, FontSize = 12, Foreground = Err, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(20, 0, 0, 0) });
        }
        if (detailText.Length > 0) step.Children.Add(new SelectableTextBlock { Text = detailText, FontFamily = Mono, FontSize = 11.5, Foreground = Muted, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(20, 0, 0, 0) });
        _host.Children.Add(new Border { Child = step, Padding = new Thickness(12, 6), Margin = new Thickness(0, 0, 0, 6), CornerRadius = new CornerRadius(6), Background = ToolBackground });
        ScrollToEnd();
    }

    /// <summary>
    /// The first lines of a tool's output that actually say something. Tool output often opens by
    /// restating the call ("edited stats.py", "now reads:"), which would consume the whole preview and
    /// tell the reader nothing they cannot see in the step header.
    /// </summary>
    private static string FirstLines(string text, int count)
    {
        var lines = (text ?? "").Replace("\r\n", "\n").Split('\n').Select(line => line.TrimEnd()).Where(line => line.Length > 0).ToList();
        while (lines.Count > 0 && IsRestatement(lines[0])) lines.RemoveAt(0);
        return string.Join("\n", lines.Take(count).Select(line => line.Length > 160 ? line.Substring(0, 160) + "…" : line));
    }

    private static bool IsRestatement(string line)
    {
        var value = line.Trim();
        return value.EndsWith("now reads:", StringComparison.OrdinalIgnoreCase)
            || value.StartsWith("edited ", StringComparison.OrdinalIgnoreCase)
            || value.StartsWith("wrote ", StringComparison.OrdinalIgnoreCase)
            || value.StartsWith("created ", StringComparison.OrdinalIgnoreCase);
    }

    public void Clear()
    {
        _host.Children.Clear();
        _streamingBody = null;
        _streamingCard = null;
        _streamingText = "";
        _thinking = false;
        _openTools.Clear();
        StopSpinner();
    }

    /// <summary>Show a standalone message with no conversation history behind it.</summary>
    public void ShowSystem(string text)
    {
        Clear();
        Add(Role.System, null, text);
    }

    public void AddUser(string text) => Add(Role.User, "You", text);

    public void AddNote(string title, string body) => Add(Role.Note, title, body);

    /// <summary>Open the card the model streams into. Deltas append; the body re-renders when it ends.</summary>
    public void BeginAssistant(string header)
    {
        var card = CreateCard(Role.Assistant, header, "");
        _streamingCard = card.body;
        _streamingBody = card.first;
        _streamingBorder = card.border;
        _streamingText = "";
        _thinking = false;
        // Seed the card as thinking straight away. A local 35B can take half a minute to produce its
        // first token, and an empty card for that long looks like the app has stalled.
        MarkThinking();
    }

    public void AppendAssistant(string delta)
    {
        if (string.IsNullOrEmpty(delta)) return;
        if (_streamingBody is null) BeginAssistant("Kitten");
        _streamingText += delta;
        if (_streamingBody is not null)
        {
            _streamingBody.Text = _streamingText;
            _streamingBody.Foreground = Text;
            _streamingBody.FontStyle = FontStyle.Normal;
        }
        _thinking = false;
        ScrollToEnd();
    }

    /// <summary>
    /// Mark the open card as thinking. A reasoning model emits its reasoning before any answer, so the
    /// card it streams into would otherwise sit empty for a minute with no sign of life. The reasoning
    /// itself is never shown — only that it is happening.
    /// </summary>
    public void MarkThinking()
    {
        if (_thinking || _streamingText.Length > 0 || _streamingBody is null) return;
        _thinking = true;
        _streamingBody.Text = "thinking…";
        _streamingBody.Foreground = Faint;
        _streamingBody.FontStyle = FontStyle.Italic;
    }

    /// <summary>
    /// Close the streaming card and lay its text out properly. Fenced code is only recognisable once
    /// the closing fence has arrived, so structure is applied at the end rather than mid-stream.
    /// </summary>
    public void CompleteAssistant(string? finalText = null)
    {
        var text = string.IsNullOrWhiteSpace(finalText) ? _streamingText : finalText!;
        // A turn that only called tools produces no prose. Drop the card rather than leaving an empty
        // one — or worse, one still reading "thinking…" after the turn is over.
        if (string.IsNullOrWhiteSpace(text) && _streamingBorder is not null)
        {
            _host.Children.Remove(_streamingBorder);
            _streamingBorder = null;
            _streamingBody = null;
            _streamingCard = null;
            _streamingText = "";
            _thinking = false;
            return;
        }
        if (_streamingCard is not null)
        {
            _streamingCard.Children.Clear();
            foreach (var block in RenderBody(text)) _streamingCard.Children.Add(block);
        }
        _streamingBody = null;
        _streamingCard = null;
        _streamingText = "";
        _thinking = false;
        ScrollToEnd();
    }

    public bool IsStreaming => _streamingBody is not null;

    /// <summary>
    /// Rebuild the surface from a replayed conversation. History arrives as one already-rendered
    /// string, so it is split back into cards on the markers the replay writes.
    /// </summary>
    public void Replay(string transcript)
    {
        Clear();
        if (string.IsNullOrWhiteSpace(transcript)) return;
        Role role = Role.Note;
        string? header = null;
        var body = new System.Text.StringBuilder();
        void Flush()
        {
            var text = body.ToString().Replace("\r", "").Trim('\n').TrimEnd();
            if (!string.IsNullOrWhiteSpace(text) || header is not null) Add(role, header, text);
            body.Clear();
        }
        var started = false;
        var inCode = false;
        foreach (var line in transcript.Replace("\r\n", "\n").Replace("\r", "\n").Split('\n'))
        {
            if (line.TrimStart().StartsWith("```", StringComparison.Ordinal)) inCode = !inCode;
            var marker = inCode ? null : MarkerFor(line);
            if (marker is not null)
            {
                if (started) Flush();
                started = true;
                role = marker.Value.role;
                header = marker.Value.header;
                var remainder = line.Substring(marker.Value.consumed).TrimStart();
                if (remainder.Length > 0) body.Append(remainder).Append('\n');
                continue;
            }
            body.Append(line).Append('\n');
        }
        if (started || body.Length > 0) Flush();
        ScrollToEnd();
    }

    /// <summary>Markers the live and replay paths write ahead of each section.</summary>
    private static (Role role, string header, int consumed)? MarkerFor(string line)
    {
        if (line.StartsWith("You: ", StringComparison.Ordinal)) return (Role.User, "You", 5);
        if (line.StartsWith("Kitten: ", StringComparison.Ordinal)) return (Role.Assistant, "Kitten", 8);
        if (line.StartsWith("Outcome: ", StringComparison.Ordinal)) return (Role.Note, "Outcome", 9);
        if (line.StartsWith(ToolMarker, StringComparison.Ordinal)) return (Role.Tool, "", ToolMarker.Length);
        foreach (var prefix in new[] { "Sidecar postflight", "Sidecar failure card", "Sidecar plan for:", "Native verification", "Bounded implementation results", "Approval ", "Task contract" })
        {
            if (line.StartsWith(prefix, StringComparison.Ordinal)) return (Role.Note, prefix.TrimEnd(':', ' '), 0);
        }
        return null;
    }

    /// <summary>Replay writes tool steps with this prefix so they can be rebuilt as steps, not prose.</summary>
    public const string ToolMarker = "⚙ ";

    public static string ToolLine(string name, string target, bool ok, long durationMs, string output)
    {
        var head = $"{ToolMarker}{name}\t{target}\t{(ok ? "ok" : "failed")}\t{durationMs}";
        var detail = FirstLines(output, 2).Replace("\n", " ⏎ ");
        return detail.Length > 0 ? $"{head}\t{detail}\n" : $"{head}\n";
    }

    private void Add(Role role, string? header, string text)
    {
        if (role == Role.Tool) { AddEncodedTool(text); return; }
        CreateCard(role, header, text);
    }

    private void AddEncodedTool(string encoded)
    {
        var parts = encoded.Split('\t');
        var name = parts.Length > 0 && parts[0].Trim().Length > 0 ? parts[0].Trim() : "tool";
        var target = parts.Length > 1 ? parts[1].Trim() : "";
        var ok = parts.Length < 3 || parts[2].Trim().Equals("ok", StringComparison.OrdinalIgnoreCase);
        var durationMs = parts.Length > 3 && long.TryParse(parts[3].Trim(), out var value) ? value : 0;
        var detail = parts.Length > 4 ? parts[4].Replace(" ⏎ ", "\n") : "";
        AddTool(name, target, ok, durationMs, detail);
    }

    private (Panel body, SelectableTextBlock? first, Border border) CreateCard(Role role, string? header, string text)
    {
        var body = new StackPanel { Spacing = 6 };
        SelectableTextBlock? first = null;
        if (string.IsNullOrEmpty(text))
        {
            // The streaming case: one empty paragraph, ready to receive deltas.
            first = Paragraph("");
            body.Children.Add(first);
        }
        else
        {
            foreach (var block in RenderBody(text)) body.Children.Add(block);
            first = body.Children.Count > 0 ? body.Children[0] as SelectableTextBlock : null;
        }

        var stack = new StackPanel { Spacing = 4 };
        if (header is not null)
        {
            stack.Children.Add(new TextBlock
            {
                Text = role == Role.Note ? $"{header} · Kitten" : header,
                FontSize = 12,
                FontWeight = FontWeight.SemiBold,
                Foreground = HeaderBrush(role),
            });
        }
        stack.Children.Add(body);

        var card = new Border
        {
            Child = stack,
            Padding = new Thickness(12, 10),
            Margin = new Thickness(0, 0, 0, 10),
            CornerRadius = new CornerRadius(8),
            Background = BackgroundBrush(role),
            BorderBrush = BorderBrushFor(role),
            BorderThickness = new Thickness(role == Role.User ? 2 : 1, 1, 1, 1),
            HorizontalAlignment = HorizontalAlignment.Stretch,
        };
        _host.Children.Add(card);
        ScrollToEnd();
        return (body, first, card);
    }

    /// <summary>Split a message into prose paragraphs and fenced code blocks.</summary>
    private static IEnumerable<Control> RenderBody(string text)
    {
        // Strip carriage returns, not just newlines. A lone '\r' left by StringBuilder.AppendLine
        // survived a Trim('\n') and rendered as blank lines, which is what put unexplained dead space
        // at the bottom of every card.
        var normalized = text.Replace("\r\n", "\n").Replace("\r", "\n").Trim('\n');
        var blocks = new List<Control>();
        var buffer = new System.Text.StringBuilder();
        var code = new System.Text.StringBuilder();
        var language = "";
        var inCode = false;
        foreach (var line in normalized.Split('\n'))
        {
            var trimmed = line.TrimStart();
            if (trimmed.StartsWith("```", StringComparison.Ordinal))
            {
                if (inCode)
                {
                    blocks.Add(CodeBlock(code.ToString().TrimEnd('\n'), language));
                    code.Clear();
                    language = "";
                    inCode = false;
                }
                else
                {
                    if (buffer.Length > 0) { blocks.Add(Paragraph(buffer.ToString().Trim('\n'))); buffer.Clear(); }
                    language = trimmed.Substring(3).Trim();
                    inCode = true;
                }
                continue;
            }
            if (inCode) code.AppendLine(line);
            else buffer.AppendLine(line);
        }
        // An unterminated fence still renders as code: mid-stream text must not lose its formatting.
        if (inCode && code.Length > 0) blocks.Add(CodeBlock(code.ToString().TrimEnd('\n'), language));
        if (buffer.Length > 0)
        {
            var remainder = buffer.ToString().Trim('\n');
            if (remainder.Length > 0) blocks.Add(Paragraph(remainder));
        }
        // Never emit an empty paragraph: a blank trailing block reads as unexplained dead space inside
        // the card, which is exactly what made the first cut of these cards look broken.
        var kept = blocks.Where(block => block is not SelectableTextBlock text || !string.IsNullOrWhiteSpace(text.Text)).ToList();
        if (kept.Count == 0 && normalized.Trim('\n').Length > 0) kept.Add(Paragraph(normalized.Trim('\n')));
        return kept;
    }

    private static SelectableTextBlock Paragraph(string text) => new()
    {
        Text = text,
        TextWrapping = TextWrapping.Wrap,
        FontSize = 14.5,
        LineHeight = 22,
    };

    private static Control CodeBlock(string code, string language)
    {
        var stack = new StackPanel { Spacing = 2 };
        if (!string.IsNullOrWhiteSpace(language))
        {
            stack.Children.Add(new TextBlock { Text = language, FontSize = 11, Opacity = 0.6, FontFamily = Mono });
        }
        stack.Children.Add(new SelectableTextBlock
        {
            Text = code,
            FontFamily = Mono,
            FontSize = 13,
            TextWrapping = TextWrapping.NoWrap,
        });
        return new Border
        {
            Child = new ScrollViewer { Content = stack, HorizontalScrollBarVisibility = ScrollBarVisibility.Auto, VerticalScrollBarVisibility = ScrollBarVisibility.Disabled },
            Padding = new Thickness(10, 8),
            CornerRadius = new CornerRadius(6),
            Background = new SolidColorBrush(Color.Parse("#0b0b0d")),
            BorderBrush = new SolidColorBrush(Color.Parse("#2a2a30")),
            BorderThickness = new Thickness(1),
        };
    }

    private static IBrush HeaderBrush(Role role) => new SolidColorBrush(role switch
    {
        Role.User => Color.Parse("#7dd3fc"),
        Role.Assistant => Color.Parse("#f5d0a9"),
        Role.Note => Color.Parse("#a1a1aa"),
        _ => Color.Parse("#a1a1aa"),
    });

    private static IBrush BackgroundBrush(Role role) => new SolidColorBrush(role switch
    {
        Role.User => Color.Parse("#16181d"),
        Role.Assistant => Color.Parse("#121214"),
        Role.Note => Color.Parse("#0f0f11"),
        _ => Color.Parse("#0f0f11"),
    });

    private static IBrush BorderBrushFor(Role role) => new SolidColorBrush(role switch
    {
        Role.User => Color.Parse("#38bdf8"),
        Role.Assistant => Color.Parse("#26262b"),
        _ => Color.Parse("#1e1e22"),
    });

    private void ScrollToEnd()
    {
        // Only follow the tail when the user is already there, so reading history is not yanked away.
        if (_scroll.Offset.Y >= _scroll.Extent.Height - _scroll.Viewport.Height - 80) _scroll.ScrollToEnd();
    }
}
