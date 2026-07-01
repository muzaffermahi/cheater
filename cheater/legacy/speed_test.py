import os
import time
from openai import OpenAI

# Environment variables
BASE_URL = os.environ["LLM_BASE_URL"]
MODEL = os.environ["LLM_MODEL"]
API_KEY = os.environ["DASHSCOPE_API_KEY"]

client = OpenAI(
    api_key=API_KEY,
    base_url=BASE_URL,
)

PROMPT = """
Write a detailed explanation of how transformers work internally.
Include attention, MLP layers, residual connections, RoPE, KV cache,
and inference optimizations. Be verbose.
"""

print(f"Model: {MODEL}")
print("Sending request...\n")

start_time = time.perf_counter()
first_token_time = None
generated_text = ""

stream = client.chat.completions.create(
    model=MODEL,
    messages=[
        {"role": "user", "content": PROMPT}
    ],
    temperature=0.7,
    stream=True,
)

for chunk in stream:
    delta = chunk.choices[0].delta.content

    if delta:
        if first_token_time is None:
            first_token_time = time.perf_counter()

        generated_text += delta
        print(delta, end="", flush=True)

end_time = time.perf_counter()

print("\n\n--- RESULTS ---")

total_time = end_time - start_time

if first_token_time:
    ttft = first_token_time - start_time
    generation_time = end_time - first_token_time

    # rough approximation
    token_count = len(generated_text.split()) * 1.3

    tps = token_count / generation_time if generation_time > 0 else 0

    print(f"TTFT: {ttft:.2f}s")
    print(f"Generation Time: {generation_time:.2f}s")
    print(f"Approx Tokens: {token_count:.0f}")
    print(f"Approx TPS: {tps:.1f}")
else:
    print("No tokens received.")