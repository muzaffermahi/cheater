# Modal SWE-bench proof

The cloud runner is `modal_swebench.py`; it pins SWE-bench Verified to
`c104f840cc67f8b6eec6f759ebc8b2693d585d4a`, selects by SHA-256 order, caps two instances per
repository, and performs a remote `git ls-remote` setup smoke before freezing 20 tasks.

The agent campaign is launched by the Windows Modal CLI. Authenticate the host once:

```powershell
.modal-venv\Scripts\modal.exe token new
```

The official SWE-bench evaluator is Linux-only, so the campaign uses the existing Ubuntu WSL distro
for its `--modal` grading calls. Install the pinned evaluator there once (this downloads only the
small Python package and its normal dependencies, never a task image):

```powershell
wsl.exe -d Ubuntu-24.04 -- python3 -m venv /home/lenovo/swebench-venv
wsl.exe -d Ubuntu-24.04 -- /home/lenovo/swebench-venv/bin/python -m pip install swebench==4.1.0
wsl.exe -d Ubuntu-24.04 -- /home/lenovo/swebench-venv/bin/modal token new
```

If the host token is already present, the runner passes it to WSL in-process without printing it.

The Aliyun credential must be stored as a Modal Secret (for example `qwen-endpoint`) containing
`MODEL_ENDPOINT` and `MAAS_API_KEY`; it is never committed or placed in a task environment. The local
OMP asset is `omp-linux-x64.gz` (104,487,816 bytes, SHA-256
`7c3bd1ad0e291e171f4ebb16279e64a1fbd5d38816fafbf7b07b06451998f64f`), keeping the three compressed
agent bundles under the 250 MB transfer cap.

After authentication, freeze remotely with:

```powershell
.modal-venv\Scripts\modal.exe run cheater-pi/scripts/modal_swebench.py::freeze --revision c104f840cc67f8b6eec6f759ebc8b2693d585d4a
```

No local SWE-bench dataset or repository clone is created by this runner.

Once the token and secret exist, the complete capped proof is one command:

```powershell
$env:MODAL_SECRET_NAME = "qwen-endpoint"
.modal-venv\Scripts\modal.exe run cheater-pi/scripts/modal_swebench.py --revision c104f840cc67f8b6eec6f759ebc8b2693d585d4a --model qwen3.6-35b-a3b
```

It writes only the frozen manifest, compact trial summaries/patches, and one official grader summary
per adapter to `modal-swebench-summary.json`; the remote workers retain full trajectories.
