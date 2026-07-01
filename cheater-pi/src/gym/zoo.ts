import type { GymTask } from "./types.js";

const PYTHON_TEMPLATE = (id: string, source: string, test: string, fixture: string) => ({
  id,
  language: "python" as const,
  fullTestCommand: "python -m pytest -q",
  runMode: "generated" as const,
  source: "zoo",
  expectedTouchedFiles: [source],
  forbiddenTouchedFiles: [test, "pyproject.toml", "requirements.txt", "tests/conftest.py"],
  successCriteria: {
    focusedTestsPass: true,
    fullTestsPass: true,
    noTestEdits: true,
    noDependencyEdits: true
  },
  difficulty: "easy" as const
});

const JS_TEMPLATE = (id: string, source: string, test: string) => ({
  id,
  language: "javascript" as const,
  fullTestCommand: "npx --no-install node --test",
  runMode: "generated" as const,
  source: "zoo",
  expectedTouchedFiles: [source],
  forbiddenTouchedFiles: [test, "package.json", "package-lock.json"],
  successCriteria: {
    focusedTestsPass: true,
    fullTestsPass: true,
    noTestEdits: true,
    noDependencyEdits: true
  },
  difficulty: "easy" as const
});

const PY_TASKS: GymTask[] = [
  {
    ...PYTHON_TEMPLATE("py_import_error_001", "src/app.py", "tests/test_app.py", "tests/conftest.py"),
    title: "Fix Python import error",
    category: "import_error",
    goal: "Fix the failing test with the smallest source-code change. The module name is wrong.",
    focusedTestCommand: "python -m pytest tests/test_app.py -q",
    tags: ["python", "pytest", "import_error"],
    generated: {
      files: {
        "pyproject.toml": "[project]\nname=\"zoo_py_import_error_001\"\nversion=\"0.1.0\"\nrequires-python=\">=3.10\"\n",
        "src/app.py": "def add(a, b):\n    return a + b\n",
        "src/__init__.py": "",
        "tests/test_app.py": "from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n",
        "tests/__init__.py": ""
      }
    },
    notes: "Buggy repo: tests/test_app.py imports `from app import add` but the module is at src/app.py. Cheater should add the proper relative or sys.path fix without editing tests."
  },
  {
    ...PYTHON_TEMPLATE("py_wrong_relative_import_001", "src/pkg/util.py", "tests/test_util.py", "tests/conftest.py"),
    title: "Fix wrong relative import",
    category: "import_error",
    goal: "Fix the wrong relative import in src/pkg/util.py without editing the test.",
    focusedTestCommand: "python -m pytest tests/test_util.py -q",
    tags: ["python", "import_error", "relative_import"],
    generated: {
      files: {
        "pyproject.toml": "[project]\nname=\"zoo_py_rel_imp_001\"\nversion=\"0.1.0\"\nrequires-python=\">=3.10\"\n",
        "src/pkg/__init__.py": "",
        "src/pkg/util.py": "from .helpers import normalize\n\ndef safe(s):\n    return normalize(s).strip()\n",
        "src/pkg/helpers.py": "def normalize(s):\n    return s.lower()\n",
        "src/__init__.py": "",
        "tests/test_util.py": "import sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))\nfrom pkg.util import safe\n\ndef test_safe():\n    assert safe('  HELLO  ') == 'hello'\n",
        "tests/__init__.py": ""
      }
    }
  },
  {
    ...PYTHON_TEMPLATE("py_off_by_one_001", "src/sum_range.py", "tests/test_sum_range.py", "tests/conftest.py"),
    title: "Fix off-by-one in range sum",
    category: "off_by_one",
    goal: "sum_range(1, 4) should return 10 (1+2+3+4), not 9.",
    focusedTestCommand: "python -m pytest tests/test_sum_range.py -q",
    tags: ["python", "off_by_one"],
    generated: {
      files: {
        "pyproject.toml": "[project]\nname=\"zoo_py_offbyone_001\"\nversion=\"0.1.0\"\nrequires-python=\">=3.10\"\n",
        "src/sum_range.py": "def sum_range(start, end):\n    total = 0\n    for n in range(start, end):\n        total += n\n    return total\n",
        "src/__init__.py": "",
        "tests/test_sum_range.py": "import sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))\nfrom sum_range import sum_range\n\ndef test_sum_range_inclusive():\n    assert sum_range(1, 4) == 10\n\ndef test_sum_range_empty():\n    assert sum_range(5, 5) == 0\n",
        "tests/__init__.py": ""
      }
    }
  },
  {
    ...PYTHON_TEMPLATE("py_wrong_exception_001", "src/safe_div.py", "tests/test_safe_div.py", "tests/conftest.py"),
    title: "Use the right exception type",
    category: "wrong_exception",
    goal: "safe_div(1, 0) must raise ZeroDivisionError, not ValueError.",
    focusedTestCommand: "python -m pytest tests/test_safe_div.py -q",
    tags: ["python", "exception"],
    generated: {
      files: {
        "pyproject.toml": "[project]\nname=\"zoo_py_exc_001\"\nversion=\"0.1.0\"\nrequires-python=\">=3.10\"\n",
        "src/safe_div.py": "def safe_div(a, b):\n    if b == 0:\n        raise ValueError(\"nope\")\n    return a / b\n",
        "src/__init__.py": "",
        "tests/test_safe_div.py": "import sys, os, pytest\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))\nfrom safe_div import safe_div\n\ndef test_zero_raises():\n    with pytest.raises(ZeroDivisionError):\n        safe_div(1, 0)\n\ndef test_normal_div():\n    assert safe_div(10, 2) == 5\n",
        "tests/__init__.py": ""
      }
    }
  },
  {
    ...PYTHON_TEMPLATE("py_fixture_scope_001", "src/counter.py", "tests/test_counter.py", "tests/conftest.py"),
    title: "Fix pytest fixture scope misuse",
    category: "fixture_scope",
    goal: "The shared counter fixture is leaking state between tests. Use the right scope.",
    focusedTestCommand: "python -m pytest tests/test_counter.py -q",
    tags: ["python", "pytest", "fixture"],
    generated: {
      files: {
        "pyproject.toml": "[project]\nname=\"zoo_py_fixture_001\"\nversion=\"0.1.0\"\nrequires-python=\">=3.10\"\n",
        "src/counter.py": "def make_counter():\n    state = {\"n\": 0}\n    def inc():\n        state[\"n\"] += 1\n        return state[\"n\"]\n    return inc\n",
        "src/__init__.py": "",
        "tests/conftest.py": "import sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))\nimport pytest\nfrom counter import make_counter\n\n@pytest.fixture(scope=\"module\")\ndef counter():\n    return make_counter()\n",
        "tests/test_counter.py": "from conftest import *  # noqa\n\ndef test_first(counter):\n    assert counter() == 1\n\ndef test_second(counter):\n    assert counter() == 1\n",
        "tests/__init__.py": ""
      }
    }
  },
  {
    ...PYTHON_TEMPLATE("py_async_not_awaited_001", "src/fetcher.py", "tests/test_fetcher.py", "tests/conftest.py"),
    title: "Await the async function",
    category: "async_misuse",
    goal: "fetch_all() must return a list of values, not a list of coroutines.",
    focusedTestCommand: "python -m pytest tests/test_fetcher.py -q",
    tags: ["python", "async"],
    generated: {
      files: {
        "pyproject.toml": "[project]\nname=\"zoo_py_async_001\"\nversion=\"0.1.0\"\nrequires-python=\">=3.10\"\n",
        "src/fetcher.py": "import asyncio\n\nasync def _fetch_one(x):\n    await asyncio.sleep(0)\n    return x * 2\n\ndef fetch_all(values):\n    coros = [_fetch_one(v) for v in values]\n    return coros\n",
        "src/__init__.py": "",
        "tests/test_fetcher.py": "import sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))\nimport asyncio\nfrom fetcher import fetch_all\n\ndef test_fetch_all():\n    out = fetch_all([1, 2, 3])\n    assert sorted(out) == [2, 4, 6]\n\ndef test_fetch_all_empty():\n    assert fetch_all([]) == []\n",
        "tests/__init__.py": ""
      }
    }
  },
  {
    ...PYTHON_TEMPLATE("py_path_handling_001", "src/loader.py", "tests/test_loader.py", "tests/conftest.py"),
    title: "Fix Windows-style path handling",
    category: "path_handling",
    goal: "join_paths should work when given a Windows-style absolute path on POSIX too.",
    focusedTestCommand: "python -m pytest tests/test_loader.py -q",
    tags: ["python", "path"],
    generated: {
      files: {
        "pyproject.toml": "[project]\nname=\"zoo_py_path_001\"\nversion=\"0.1.0\"\nrequires-python=\">=3.10\"\n",
        "src/loader.py": "import os\n\ndef join_paths(base, *parts):\n    if base.startswith('/') or base[1:3] == ':\\\\':\n        return os.path.join(base, *parts)\n    return os.path.join(os.getcwd(), base, *parts)\n",
        "src/__init__.py": "",
        "tests/test_loader.py": "import sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))\nfrom loader import join_paths\n\ndef test_join_absolute():\n    out = join_paths('/tmp', 'a', 'b.txt')\n    assert out.endswith(os.path.join('a', 'b.txt'))\n\ndef test_join_relative():\n    out = join_paths('rel', 'a', 'b.txt')\n    assert out.endswith(os.path.join('rel', 'a', 'b.txt'))\n",
        "tests/__init__.py": ""
      }
    }
  },
  {
    ...PYTHON_TEMPLATE("py_json_serialization_001", "src/encoder.py", "tests/test_encoder.py", "tests/conftest.py"),
    title: "Fix JSON serialization of dataclass",
    category: "json_serialization",
    goal: "encode() should serialize a simple dataclass to JSON; the current encoder is broken.",
    focusedTestCommand: "python -m pytest tests/test_encoder.py -q",
    tags: ["python", "json"],
    generated: {
      files: {
        "pyproject.toml": "[project]\nname=\"zoo_py_json_001\"\nversion=\"0.1.0\"\nrequires-python=\">=3.10\"\n",
        "src/encoder.py": "import json\nfrom dataclasses import dataclass\n\n@dataclass\nclass Item:\n    name: str\n    qty: int\n\ndef encode(item):\n    return json.dumps({\"name\": item[\"name\"], \"qty\": item[\"qty\"]})\n",
        "src/__init__.py": "",
        "tests/test_encoder.py": "import sys, os, json\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))\nfrom encoder import encode, Item\n\ndef test_encode_item():\n    out = encode(Item(\"apple\", 3))\n    assert json.loads(out) == {\"name\": \"apple\", \"qty\": 3}\n",
        "tests/__init__.py": ""
      }
    }
  },
  {
    ...PYTHON_TEMPLATE("py_cli_parsing_001", "src/cli.py", "tests/test_cli.py", "tests/conftest.py"),
    title: "Fix CLI argument parsing",
    category: "cli_parsing",
    goal: "parse() should read --count as an int, but currently always returns 1.",
    focusedTestCommand: "python -m pytest tests/test_cli.py -q",
    tags: ["python", "cli"],
    generated: {
      files: {
        "pyproject.toml": "[project]\nname=\"zoo_py_cli_001\"\nversion=\"0.1.0\"\nrequires-python=\">=3.10\"\n",
        "src/cli.py": "import argparse\n\ndef parse(argv):\n    p = argparse.ArgumentParser()\n    p.add_argument(\"--count\", default=1)\n    args = p.parse_args(argv)\n    return {\"count\": int(args.count) if args.count is not None else 1}\n",
        "src/__init__.py": "",
        "tests/test_cli.py": "import sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))\nfrom cli import parse\n\ndef test_default_count():\n    assert parse([])[\"count\"] == 1\n\ndef test_count_value():\n    assert parse([\"--count\", \"5\"])[\"count\"] == 5\n",
        "tests/__init__.py": ""
      }
    }
  },
  {
    ...PYTHON_TEMPLATE("py_config_parsing_001", "src/config.py", "tests/test_config.py", "tests/conftest.py"),
    title: "Fix env/config parsing",
    category: "config_parsing",
    goal: "load() should read APP_PORT from env, defaulting to 8080; currently it ignores APP_PORT.",
    focusedTestCommand: "python -m pytest tests/test_config.py -q",
    tags: ["python", "config", "env"],
    generated: {
      files: {
        "pyproject.toml": "[project]\nname=\"zoo_py_cfg_001\"\nversion=\"0.1.0\"\nrequires-python=\">=3.10\"\n",
        "src/config.py": "import os\n\nDEFAULTS = {\"APP_PORT\": 8080, \"APP_DEBUG\": False}\n\ndef load():\n    out = {}\n    for k, default in DEFAULTS.items():\n        if k in os.environ:\n            out[k] = int(os.environ[k]) if k == \"APP_PORT\" else os.environ[k].lower() == \"true\"\n        else:\n            out[k] = default\n    return out\n",
        "src/__init__.py": "",
        "tests/test_config.py": "import sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))\nimport importlib\nfrom config import load\n\ndef test_default_port(monkeypatch):\n    monkeypatch.delenv(\"APP_PORT\", raising=False)\n    import config as cfg\n    importlib.reload(cfg)\n    assert cfg.load()[\"APP_PORT\"] == 8080\n\ndef test_env_port(monkeypatch):\n    monkeypatch.setenv(\"APP_PORT\", \"9090\")\n    import config as cfg\n    importlib.reload(cfg)\n    assert cfg.load()[\"APP_PORT\"] == 9090\n",
        "tests/__init__.py": ""
      }
    }
  },
  {
    ...PYTHON_TEMPLATE("py_dedup_001", "src/dedup.py", "tests/test_dedup.py", "tests/conftest.py"),
    title: "Fix duplicate filtering",
    category: "duplicate_filter",
    goal: "unique([1,1,2,2,3,3]) should return [1,2,3] preserving order; current output is wrong.",
    focusedTestCommand: "python -m pytest tests/test_dedup.py -q",
    tags: ["python", "dedup"],
    generated: {
      files: {
        "pyproject.toml": "[project]\nname=\"zoo_py_dedup_001\"\nversion=\"0.1.0\"\nrequires-python=\">=3.10\"\n",
        "src/dedup.py": "def unique(items):\n    seen = set()\n    out = []\n    for item in items:\n        if item in seen:\n            out.append(item)\n        else:\n            seen.add(item)\n    return out\n",
        "src/__init__.py": "",
        "tests/test_dedup.py": "import sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))\nfrom dedup import unique\n\ndef test_unique_preserves_order():\n    assert unique([1, 1, 2, 2, 3, 3]) == [1, 2, 3]\n\ndef test_unique_strings():\n    assert unique([\"a\", \"b\", \"a\", \"c\"]) == [\"a\", \"b\", \"c\"]\n",
        "tests/__init__.py": ""
      }
    }
  },
  {
    ...PYTHON_TEMPLATE("py_sort_001", "src/ranker.py", "tests/test_ranker.py", "tests/conftest.py"),
    title: "Fix sorting/ranking bug",
    category: "ranking_sorting",
    goal: "top_k should return the top K items by score descending; currently it returns the bottom.",
    focusedTestCommand: "python -m pytest tests/test_ranker.py -q",
    tags: ["python", "sort"],
    generated: {
      files: {
        "pyproject.toml": "[project]\nname=\"zoo_py_sort_001\"\nversion=\"0.1.0\"\nrequires-python=\">=3.10\"\n",
        "src/ranker.py": "def top_k(items, k):\n    return sorted(items, key=lambda x: x[\"score\"])[:k]\n",
        "src/__init__.py": "",
        "tests/test_ranker.py": "import sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))\nfrom ranker import top_k\n\ndef test_top_k_descending():\n    out = top_k([{\"score\": 1}, {\"score\": 5}, {\"score\": 3}], 2)\n    assert [x[\"score\"] for x in out] == [5, 3]\n",
        "tests/__init__.py": ""
      }
    }
  },
  {
    ...PYTHON_TEMPLATE("py_cache_001", "src/cache.py", "tests/test_cache.py", "tests/conftest.py"),
    title: "Fix cache invalidation bug",
    category: "cache_invalidation",
    goal: "set/del must invalidate the cached value; del is currently a no-op.",
    focusedTestCommand: "python -m pytest tests/test_cache.py -q",
    tags: ["python", "cache"],
    generated: {
      files: {
        "pyproject.toml": "[project]\nname=\"zoo_py_cache_001\"\nversion=\"0.1.0\"\nrequires-python=\">=3.10\"\n",
        "src/cache.py": "class Cache:\n    def __init__(self):\n        self._data = {}\n\n    def set(self, k, v):\n        self._data[k] = v\n\n    def get(self, k, default=None):\n        return self._data.get(k, default)\n\n    def delete(self, k):\n        if k in self._data:\n            self._data.pop(k, default=None)\n",
        "src/__init__.py": "",
        "tests/test_cache.py": "import sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))\nfrom cache import Cache\n\ndef test_set_get():\n    c = Cache()\n    c.set(\"a\", 1)\n    assert c.get(\"a\") == 1\n\ndef test_delete_invalidates():\n    c = Cache()\n    c.set(\"a\", 1)\n    c.delete(\"a\")\n    assert c.get(\"a\") is None\n",
        "tests/__init__.py": ""
      }
    }
  },
  {
    ...PYTHON_TEMPLATE("py_regex_001", "src/splitter.py", "tests/test_splitter.py", "tests/conftest.py"),
    title: "Fix regex edge case",
    category: "regex_edge",
    goal: "split_csv should not produce empty fields when given a trailing newline.",
    focusedTestCommand: "python -m pytest tests/test_splitter.py -q",
    tags: ["python", "regex"],
    generated: {
      files: {
        "pyproject.toml": "[project]\nname=\"zoo_py_regex_001\"\nversion=\"0.1.0\"\nrequires-python=\">=3.10\"\n",
        "src/splitter.py": "import re\n\ndef split_csv(text):\n    return re.split(r\",\", text)\n",
        "src/__init__.py": "",
        "tests/test_splitter.py": "import sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))\nfrom splitter import split_csv\n\ndef test_basic():\n    assert split_csv(\"a,b,c\") == [\"a\", \"b\", \"c\"]\n\ndef test_trailing_newline():\n    assert split_csv(\"a,b,c\\n\") == [\"a\", \"b\", \"c\\n\"]\n",
        "tests/__init__.py": ""
      }
    }
  },
  {
    ...PYTHON_TEMPLATE("py_datetime_001", "src/when.py", "tests/test_when.py", "tests/conftest.py"),
    title: "Fix date/time parsing bug",
    category: "datetime_parsing",
    goal: "parse_iso must accept trailing 'Z' as UTC; currently it raises ValueError.",
    focusedTestCommand: "python -m pytest tests/test_when.py -q",
    tags: ["python", "datetime"],
    generated: {
      files: {
        "pyproject.toml": "[project]\nname=\"zoo_py_dt_001\"\nversion=\"0.1.0\"\nrequires-python=\">=3.10\"\n",
        "src/when.py": "from datetime import datetime\n\ndef parse_iso(s):\n    return datetime.fromisoformat(s)\n",
        "src/__init__.py": "",
        "tests/test_when.py": "import sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))\nfrom when import parse_iso\n\ndef test_parse_with_z():\n    dt = parse_iso(\"2024-01-01T00:00:00Z\")\n    assert dt.year == 2024 and dt.month == 1 and dt.day == 1\n",
        "tests/__init__.py": ""
      }
    }
  },
  {
    ...PYTHON_TEMPLATE("py_type_conversion_001", "src/coercer.py", "tests/test_coercer.py", "tests/conftest.py"),
    title: "Fix type conversion bug",
    category: "type_conversion",
    goal: "to_int('3.5') should return 3 (or raise a clear error), not silently 0.",
    focusedTestCommand: "python -m pytest tests/test_coercer.py -q",
    tags: ["python", "type"],
    generated: {
      files: {
        "pyproject.toml": "[project]\nname=\"zoo_py_conv_001\"\nversion=\"0.1.0\"\nrequires-python=\">=3.10\"\n",
        "src/coercer.py": "def to_int(value):\n    try:\n        return int(value)\n    except (TypeError, ValueError):\n        return 0\n",
        "src/__init__.py": "",
        "tests/test_coercer.py": "import sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))\nfrom coercer import to_int\n\ndef test_int_string():\n    assert to_int(\"42\") == 42\n\ndef test_float_string():\n    assert to_int(\"3.5\") == 3\n\ndef test_invalid_string():\n    assert to_int(\"nope\") == 0\n",
        "tests/__init__.py": ""
      }
    }
  },
  {
    ...PYTHON_TEMPLATE("py_package_export_001", "src/pkg/__init__.py", "tests/test_pkg.py", "tests/conftest.py"),
    title: "Fix package __init__ export",
    category: "package_export",
    goal: "from pkg import Greeter must work; current __init__ does not export it.",
    focusedTestCommand: "python -m pytest tests/test_pkg.py -q",
    tags: ["python", "package"],
    generated: {
      files: {
        "pyproject.toml": "[project]\nname=\"zoo_py_pkg_001\"\nversion=\"0.1.0\"\nrequires-python=\">=3.10\"\n",
        "src/pkg/__init__.py": "from .greeter import Greeter  # noqa: F401\n",
        "src/pkg/greeter.py": "class Greeter:\n    def __init__(self, name):\n        self.name = name\n\n    def greet(self):\n        return f\"hello, {self.name}\"\n",
        "src/__init__.py": "",
        "tests/test_pkg.py": "import sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))\nfrom pkg import Greeter\n\ndef test_greeter():\n    assert Greeter(\"world\").greet() == \"hello, world\"\n",
        "tests/__init__.py": ""
      }
    }
  },
  {
    ...PYTHON_TEMPLATE("py_test_state_leak_001", "src/registry.py", "tests/test_registry.py", "tests/conftest.py"),
    title: "Fix test state leakage",
    category: "test_state_leak",
    goal: "register() must not leak state between tests; current module-level dict persists.",
    focusedTestCommand: "python -m pytest tests/test_registry.py -q",
    tags: ["python", "test_state"],
    generated: {
      files: {
        "pyproject.toml": "[project]\nname=\"zoo_py_state_001\"\nversion=\"0.1.0\"\nrequires-python=\">=3.10\"\n",
        "src/registry.py": "_items = []\n\ndef register(name, value):\n    _items.append((name, value))\n\ndef all_items():\n    return list(_items)\n\ndef reset():\n    _items.clear()\n",
        "src/__init__.py": "",
        "tests/test_registry.py": "import sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))\nimport registry\n\ndef test_register_one():\n    registry.reset()\n    registry.register(\"a\", 1)\n    assert registry.all_items() == [(\"a\", 1)]\n\ndef test_register_two_isolated():\n    registry.reset()\n    registry.register(\"b\", 2)\n    assert registry.all_items() == [(\"b\", 2)]\n",
        "tests/__init__.py": ""
      }
    }
  }
];

const JS_TASKS: GymTask[] = [
  {
    ...JS_TEMPLATE("js_wrong_export_001", "src/math.js", "test/math.test.js"),
    title: "Fix wrong export name",
    category: "wrong_export",
    goal: "math.js should export `add`, but the test imports `sum`; fix the export without editing the test.",
    focusedTestCommand: "node --test test/math.test.js",
    tags: ["javascript", "export"],
    generated: {
      files: {
        "package.json": "{\n  \"name\": \"zoo-js-export-001\",\n  \"version\": \"0.1.0\",\n  \"type\": \"module\",\n  \"scripts\": { \"test\": \"node --test\" }\n}\n",
        "src/math.js": "export function sum(a, b) {\n  return a + b;\n}\n",
        "test/math.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n\ntest('add works', () => {\n  assert.equal(add(2, 3), 5);\n});\n"
      }
    }
  },
  {
    ...JS_TEMPLATE("js_promise_not_awaited_001", "src/loader.js", "test/loader.test.js"),
    title: "Await the promise",
    category: "promise_not_awaited",
    goal: "loadAll must resolve to a list of values, not a list of promises.",
    focusedTestCommand: "node --test test/loader.test.js",
    tags: ["javascript", "async"],
    generated: {
      files: {
        "package.json": "{\n  \"name\": \"zoo-js-async-001\",\n  \"version\": \"0.1.0\",\n  \"type\": \"module\",\n  \"scripts\": { \"test\": \"node --test\" }\n}\n",
        "src/loader.js": "export async function fetchOne(x) {\n  return x * 2;\n}\n\nexport function loadAll(values) {\n  return values.map((v) => fetchOne(v));\n}\n",
        "test/loader.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { loadAll } from '../src/loader.js';\n\ntest('loadAll resolves to values', async () => {\n  const out = await Promise.all(loadAll([1, 2, 3]));\n  assert.deepEqual(out.sort(), [2, 4, 6]);\n});\n\ntest('loadAll empty', async () => {\n  const out = await Promise.all(loadAll([]));\n  assert.deepEqual(out, []);\n});\n"
      }
    }
  },
  {
    ...JS_TEMPLATE("js_path_normalization_001", "src/paths.js", "test/paths.test.js"),
    title: "Fix path normalization",
    category: "path_normalization",
    goal: "normalize should resolve '.' and '..' segments; current implementation does not.",
    focusedTestCommand: "node --test test/paths.test.js",
    tags: ["javascript", "path"],
    generated: {
      files: {
        "package.json": "{\n  \"name\": \"zoo-js-path-001\",\n  \"version\": \"0.1.0\",\n  \"type\": \"module\",\n  \"scripts\": { \"test\": \"node --test\" }\n}\n",
        "src/paths.js": "import path from 'node:path';\n\nexport function normalize(p) {\n  return p.split('/').join(path.sep);\n}\n",
        "test/paths.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { normalize } from '../src/paths.js';\n\ntest('normalize resolves ..', () => {\n  assert.equal(normalize('a/b/../c'), 'a/c');\n});\n\ntest('normalize resolves .', () => {\n  assert.equal(normalize('a/./b'), 'a/b');\n});\n"
      }
    }
  },
  {
    ...JS_TEMPLATE("js_json_parsing_001", "src/parse.js", "test/parse.test.js"),
    title: "Fix JSON parsing edge case",
    category: "json_parsing",
    goal: "safeParse must return null for invalid JSON without throwing.",
    focusedTestCommand: "node --test test/parse.test.js",
    tags: ["javascript", "json"],
    generated: {
      files: {
        "package.json": "{\n  \"name\": \"zoo-js-json-001\",\n  \"version\": \"0.1.0\",\n  \"type\": \"module\",\n  \"scripts\": { \"test\": \"node --test\" }\n}\n",
        "src/parse.js": "export function safeParse(text) {\n  return JSON.parse(text);\n}\n",
        "test/parse.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { safeParse } from '../src/parse.js';\n\ntest('parses object', () => {\n  assert.deepEqual(safeParse('{\"a\":1}'), { a: 1 });\n});\n\ntest('returns null for invalid', () => {\n  assert.equal(safeParse('not json'), null);\n});\n"
      }
    }
  },
  {
    ...JS_TEMPLATE("js_sort_001", "src/ranker.js", "test/ranker.test.js"),
    title: "Fix sorting bug",
    category: "ranking_sorting",
    goal: "topK must return the top K items by score descending; currently ascending.",
    focusedTestCommand: "node --test test/ranker.test.js",
    tags: ["javascript", "sort"],
    generated: {
      files: {
        "package.json": "{\n  \"name\": \"zoo-js-sort-001\",\n  \"version\": \"0.1.0\",\n  \"type\": \"module\",\n  \"scripts\": { \"test\": \"node --test\" }\n}\n",
        "src/ranker.js": "export function topK(items, k) {\n  return items.slice().sort((a, b) => a.score - b.score).slice(0, k);\n}\n",
        "test/ranker.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { topK } from '../src/ranker.js';\n\ntest('topK descending', () => {\n  const out = topK([{ score: 1 }, { score: 5 }, { score: 3 }], 2);\n  assert.deepEqual(out.map((x) => x.score), [5, 3]);\n});\n"
      }
    }
  },
  {
    ...JS_TEMPLATE("js_config_parsing_001", "src/config.js", "test/config.test.js"),
    title: "Fix env config parsing",
    category: "config_parsing",
    goal: "loadConfig must read PORT from env, default 8080; currently ignores env.",
    focusedTestCommand: "node --test test/config.test.js",
    tags: ["javascript", "config", "env"],
    generated: {
      files: {
        "package.json": "{\n  \"name\": \"zoo-js-cfg-001\",\n  \"version\": \"0.1.0\",\n  \"type\": \"module\",\n  \"scripts\": { \"test\": \"node --test\" }\n}\n",
        "src/config.js": "const DEFAULTS = { PORT: 8080 };\n\nexport function loadConfig() {\n  const out = {};\n  for (const [k, v] of Object.entries(DEFAULTS)) {\n    out[k] = v;\n  }\n  return out;\n}\n",
        "test/config.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { loadConfig } from '../src/config.js';\n\ntest('default port', () => {\n  delete process.env.PORT;\n  assert.equal(loadConfig().PORT, 8080);\n});\n\ntest('env port', () => {\n  process.env.PORT = '9090';\n  assert.equal(loadConfig().PORT, 9090);\n  delete process.env.PORT;\n});\n"
      }
    }
  },
  {
    ...JS_TEMPLATE("js_tsc_failure_001", "src/total.ts", "test/total.test.ts"),
    title: "Fix TypeScript type error",
    category: "tsc_failure",
    goal: "sum should accept numbers only; current declaration lies. Fix the source, not the test.",
    focusedTestCommand: "node --test --experimental-strip-types test/total.test.ts",
    tags: ["typescript", "type"],
    difficulty: "medium",
    generated: {
      files: {
        "package.json": "{\n  \"name\": \"zoo-js-tsc-001\",\n  \"version\": \"0.1.0\",\n  \"type\": \"module\",\n  \"scripts\": { \"test\": \"node --test --experimental-strip-types\" }\n}\n",
        "src/total.ts": "export function sum(a: number, b: number): number {\n  return a + b;\n}\n\nexport function total(values: any[]): number {\n  let s = 0;\n  for (const v of values) s += v;\n  return s;\n}\n",
        "test/total.test.ts": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from '../src/total.ts';\n\ntest('total sums numbers', () => {\n  assert.equal(total([1, 2, 3]), 6);\n});\n\ntest('total empty', () => {\n  assert.equal(total([]), 0);\n});\n"
      }
    }
  }
];

export const ZOO_TASKS: GymTask[] = [...PY_TASKS, ...JS_TASKS];
