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
    assert b.messages[-1]["content"].endswith(prompts.REMINDER)


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


# ---------------------------------------------------------------- several PDFs
from pagelight.document import collect_pdfs, load_many  # noqa: E402


@pytest.fixture(scope="module")
def library(tmp_path_factory):
    root = tmp_path_factory.mktemp("lib")
    def make(name, title, facts, n=12):
        d = pymupdf.open()
        for p in range(1, n + 1):
            d.new_page().insert_textbox(pymupdf.Rect(50, 50, 550, 800), f"{facts.get(p, '')} {FILLER}", fontsize=10)
        d.set_metadata({"title": title})
        d.save(root / name)
    make("alpha.pdf", "Alpha Paper", {5: "Alpha uses a dropout rate of 0.3 in every layer."})
    make("beta.pdf", "Beta Paper", {8: "Beta reports a top-1 accuracy of 91 percent on the benchmark."})
    (root / "nested").mkdir()
    make("nested/gamma.pdf", "Gamma Notes", {3: "Gamma was trained on 512 TPU cores for a week."})
    (root / "nested" / "copy.pdf").write_bytes((root / "alpha.pdf").read_bytes())
    docs, problems = load_many(collect_pdfs([str(root)]))
    return docs, problems


def test_folder_loading_dedupes(library):
    docs, problems = library
    assert [d.label for d in docs] == ["D1", "D2", "D3"]
    assert any("duplicate" in p for p in problems)
    assert all(c.doc == d.index for d in docs for c in d.chunks)


def test_search_across_documents(library):
    docs, _ = library
    r = Retriever(docs)
    assert (r.search("dropout rate", k=1)[0][0].doc, r.search("dropout rate", k=1)[0][0].page) == (0, 5)
    hit = r.search("how many TPU cores", k=1)[0][0]
    assert (hit.doc, hit.page) == (2, 3)
    assert all(c.doc == 1 for c, _ in r.search("accuracy", k=5, docs={1}))


def test_multi_prompt_labels_and_citations(library):
    docs, _ = library
    b = prompts.build(docs, Retriever(docs), "what accuracy does beta report?", 2, "", [], 4096, doc_index=0)
    assert b.multi and (1, 8) in b.sources
    assert "[D2 p. 8]" in b.messages[-1]["content"] and "D3:" in b.messages[0]["content"]
    assert '<pdf id="D2"' in b.messages[-1]["content"]
    assert b.messages[-1]["content"].endswith(prompts.REMINDER_MULTI)


def test_scope_doc_and_named_docs(library):
    docs, _ = library
    r = Retriever(docs)
    only = prompts.build(docs, r, "what accuracy is reported?", 2, "", [], 4096, doc_index=0, scope="doc")
    assert not only.multi and {d for d, _ in only.sources} == {0}
    named = prompts.build(docs, r, "summarize D3", 2, "", [], 4096, doc_index=0)
    assert {d for d, _ in named.sources} == {2}
