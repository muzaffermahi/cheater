from datasets import load_dataset

from huggingface_hub import login

login("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")



HF_TOKEN = "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"

ds = load_dataset('nebius/swe-agent-trajectories')
