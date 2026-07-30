using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Layout;
using Avalonia.Media;

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

    private static readonly FontFamily Mono = new("Cascadia Mono,Consolas,Menlo,monospace");

    public TranscriptView(Panel host, ScrollViewer scroll)
    {
        _host = host;
        _scroll = scroll;
    }

    public enum Role { User, Assistant, Note, System }

    public void Clear()
    {
        _host.Children.Clear();
        _streamingBody = null;
        _streamingCard = null;
        _streamingText = "";
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
        _streamingText = "";
    }

    public void AppendAssistant(string delta)
    {
        if (string.IsNullOrEmpty(delta)) return;
        if (_streamingBody is null) BeginAssistant("Kitten");
        _streamingText += delta;
        if (_streamingBody is not null) _streamingBody.Text = _streamingText;
        ScrollToEnd();
    }

    /// <summary>
    /// Close the streaming card and lay its text out properly. Fenced code is only recognisable once
    /// the closing fence has arrived, so structure is applied at the end rather than mid-stream.
    /// </summary>
    public void CompleteAssistant(string? finalText = null)
    {
        var text = string.IsNullOrWhiteSpace(finalText) ? _streamingText : finalText!;
        if (_streamingCard is not null)
        {
            _streamingCard.Children.Clear();
            foreach (var block in RenderBody(text)) _streamingCard.Children.Add(block);
        }
        _streamingBody = null;
        _streamingCard = null;
        _streamingText = "";
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
            var text = body.ToString().Trim('\n');
            if (!string.IsNullOrWhiteSpace(text) || header is not null) Add(role, header, text);
            body.Clear();
        }
        var started = false;
        var inCode = false;
        foreach (var line in transcript.Replace("\r\n", "\n").Split('\n'))
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
                if (remainder.Length > 0) body.AppendLine(remainder);
                continue;
            }
            body.AppendLine(line);
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
        foreach (var prefix in new[] { "Sidecar postflight", "Sidecar failure card", "Sidecar plan for:", "Native verification", "Bounded implementation results", "Tool ", "Approval " })
        {
            if (line.StartsWith(prefix, StringComparison.Ordinal)) return (Role.Note, prefix.TrimEnd(':', ' '), 0);
        }
        return null;
    }

    private void Add(Role role, string? header, string text) => CreateCard(role, header, text);

    private (Panel body, SelectableTextBlock? first) CreateCard(Role role, string? header, string text)
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
        return (body, first);
    }

    /// <summary>Split a message into prose paragraphs and fenced code blocks.</summary>
    private static IEnumerable<Control> RenderBody(string text)
    {
        var normalized = text.Replace("\r\n", "\n");
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
        if (blocks.Count == 0) blocks.Add(Paragraph(normalized.Trim('\n')));
        return blocks;
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
