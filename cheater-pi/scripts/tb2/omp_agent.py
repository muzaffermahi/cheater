"""Harbor adapter for the pinned oh-my-pi 17.2.7 Linux bundle.

The adapter passes only a loopback-style OpenAI endpoint into the task. Authentication is deliberately
dummy text: the host credential proxy replaces it before forwarding and never logs it.
"""
import os
import shlex
from pathlib import Path
from harbor.agents.installed.base import BaseInstalledAgent, ExecInput
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths


class OmpAgent(BaseInstalledAgent):
    @staticmethod
    def name() -> str:
        return "omp"

    @property
    def _install_agent_template_path(self) -> Path:
        return Path(__file__).with_name("install-omp.sh.j2")

    def create_run_agent_commands(self, instruction: str) -> list[ExecInput]:
        agent_dir = str(EnvironmentPaths.agent_dir).replace("\\", "/")
        model = self.model_name or os.environ.get("TB2_OMP_MODEL", "loopback/qwen3.6-35b-a3b")
        endpoint = os.environ.get("TB2_MODEL_ENDPOINT", "http://host.docker.internal:11435/v1")
        env = {
            "OPENAI_BASE_URL": endpoint,
            "OPENAI_API_KEY": "loopback-only",
            "OMP_MODEL": model,
            "PI_NO_TITLE": "1",
            "PI_NO_PTY": "1",
            "PI_CODING_AGENT_DIR": f"{agent_dir}/omp-home",
            "NO_PROXY": "host.docker.internal,127.0.0.1,localhost",
            "KITTEN_BENCH_PROFILE": "minimal",
        }
        model_id = model.split("/", 1)[1] if "/" in model else model
        models_yml = f"providers:\n  loopback:\n    baseUrl: {endpoint}\n    api: openai-completions\n    auth: none\n    models:\n      - id: {model_id}\n        name: qwen 3.6 35b\n        contextWindow: 32768\n        maxTokens: 8192\n"
        return [
            ExecInput(command=f"mkdir -p {shlex.quote(agent_dir)}/omp-home; printf %s {shlex.quote(models_yml)} > {shlex.quote(agent_dir)}/omp-home/models.yml", env=env),
            ExecInput(command=f"omp -p --mode text --auto-approve --no-session --max-time 780 --no-pty --model {shlex.quote(model)} {shlex.quote(instruction)} 2>&1 | tee {shlex.quote(agent_dir)}/omp-console.log", env=env),
            ExecInput(command=f"sync; ls -laR {shlex.quote(agent_dir)} > {shlex.quote(agent_dir)}/agent-dir-listing.txt 2>&1 || true", env={}),
        ]

    def populate_context_post_run(self, context: AgentContext) -> None:
        return
