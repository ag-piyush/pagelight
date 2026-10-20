"""Run with:  pip install pytest && pytest -q"""

import pymupdf
import pytest

from pagelight import prompts
from pagelight.document import load
from pagelight.llm import LLMError, ensure_local, pick_chat_model, pick_embed_model
from pagelight.retrieval import Retriever, tokenize

FILLER = "Neural models learn representations from data through stacked layers. " * 40
FACTS = {
    4: "The optimizer is Adam with a peak learning rate of 3e-4 and 4000 warmup steps.",
    9: "Eight attention heads run in parallel, each with key dimension 64.",
    14: "A limitation is the quadratic cost of attention in sequence length.",
}


@pytest.fixture(scope="module")
def doc(tmp_path_factory):
    path = tmp_path_factory.mktemp("pdf") / "t.pdf"
    d = pymupdf.open()
    for p in range(1, 16):
        page = d.new_page()
        page.insert_textbox(pymupdf.Rect(50, 50, 550, 800), f"{FACTS.get(p, '')} {FILLER}", fontsize=10)
    d.set_metadata({"title": "Test Paper"})
    d.save(path)
    return load(path)


def test_load(doc):
    assert doc.title == "Test Paper" and doc.n_pages == 15
    assert all(c.page >= 1 for c in doc.chunks)


def test_stemming_matches_word_forms():
    assert tokenize("use uses used using") == ["us"] * 4
    assert tokenize("heads") == tokenize("head")


@pytest.mark.parametrize("q,page", [("what learning rate do they use", 4), ("how many heads", 9), ("limitations of the approach", 14)])
def test_retrieval_finds_the_right_page(doc, q, page):
    assert Retriever(doc).search(q, k=1)[0][0].page == page


def test_prompt_includes_current_page_and_hits(doc):
    b = prompts.build(doc, Retriever(doc), "what learning rate do they use?", 12, "", [], 4096)
    assert b.mode == "retrieval" and 12 in b.pages_used and 4 in b.pages_used
    assert "[p. 4]" in b.messages[-1]["content"]


def test_this_page_uses_neighbours(doc):
    b = prompts.build(doc, Retriever(doc), "Summarize this page", 7, "", [], 4096)
    assert {6, 7, 8} <= set(b.pages_used)


def test_selection_and_history(doc):
    hist = [{"role": "assistant", "content": "orphan"}, {"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]
    b = prompts.build(doc, Retriever(doc), "explain", 3, "quadratic cost", hist, 4096)
    assert b.messages[1]["role"] == "user"  # orphaned reply dropped
    assert "<selected_text" in b.messages[-1]["content"]


def test_short_doc_sent_whole(tmp_path):
    path = tmp_path / "s.pdf"
    d = pymupdf.open()
    d.new_page().insert_text((72, 72), "Only page.")
    d.save(path)
    s = load(path)
    assert prompts.build(s, Retriever(s), "what?", 1, "", [], 8192).mode == "full-document"


def test_only_local_servers():
    ensure_local("http://127.0.0.1:11434")
    ensure_local("http://localhost:8080/v1")
    with pytest.raises(LLMError):
        ensure_local("http://8.8.8.8:11434")
    with pytest.raises(LLMError):
        ensure_local("http://10.0.0.5:11434")
    ensure_local("http://10.0.0.5:11434", allow_lan=True)


def test_model_picking():
    installed = ["nomic-embed-text:latest", "qwen2.5:7b", "llama3.2:latest"]
    assert pick_chat_model(installed, None) == "llama3.2:latest"
    assert pick_chat_model(installed, "qwen2.5") == "qwen2.5:7b"
    assert pick_embed_model(installed, None) == "nomic-embed-text:latest"
    with pytest.raises(LLMError):
        pick_chat_model(installed, "llama3.1:8b")
