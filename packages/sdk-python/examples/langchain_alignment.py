"""
LangChain — alignment auditing on a ReAct agent's chain-of-thought.

The AlignmentCallback POSTs each `on_agent_action` to
/api/v1/alignment/check together with the agent's declared goal and
running thought chain. The verdict is logged to the gateway's audit
trail and (via the closed-loop bridge) also buffered for the SDK's
next /check call, so DSL rules like
`{ alignment.drifted: true }` can pause the tool dispatch on the
same hop.

Run:
    AEGIS_API_KEY=... ANTHROPIC_API_KEY=... python langchain_alignment.py

Requires `pip install agentguard-aegis[langchain] langchain langchain-anthropic`.
"""
from __future__ import annotations

import os

from agentguard.integrations.langchain import AlignmentCallback

GATEWAY_URL = os.environ.get("AGENTGUARD_URL", "http://localhost:8080")


def main() -> None:
    try:
        from langchain.agents import AgentExecutor, create_react_agent
        from langchain_anthropic import ChatAnthropic
        from langchain_core.prompts import PromptTemplate
        from langchain_core.tools import tool
    except ImportError:
        raise SystemExit(
            "pip install agentguard-aegis[langchain] langchain langchain-anthropic"
        )

    @tool
    def search(query: str) -> str:
        """Search the internal documentation index."""
        return f"(stub) results for: {query}"

    @tool
    def execute_sql(query: str) -> str:
        """Run a SQL query against the analytics DB. WARNING: prod."""
        return f"(stub) 12 rows: {query[:40]}"

    prompt = PromptTemplate.from_template(
        "You are a research assistant.\n\n"
        "TOOLS:\n{tools}\n\n"
        "Use this format:\n"
        "Thought: ...\nAction: tool_name\nAction Input: ...\nObservation: ...\n"
        "... (repeat) ...\n"
        "Final Answer: ...\n\n"
        "Question: {input}\n"
        "{agent_scratchpad}"
    )

    llm = ChatAnthropic(model="claude-haiku-4-5", temperature=0)
    tools = [search, execute_sql]
    agent = create_react_agent(llm, tools, prompt)

    callback = AlignmentCallback(
        gateway_url=GATEWAY_URL,
        agent_id="research-bot",
        declared_goal="Summarise our latest customer-feedback survey for the team meeting.",
        verbose=True,
    )

    executor = AgentExecutor(
        agent=agent,
        tools=tools,
        callbacks=[callback],
        verbose=True,
        handle_parsing_errors=True,
    )

    # The agent's declared goal is *summarising feedback*. If the model
    # decides to also DROP TABLE customers, the AlignmentCallback will
    # post a verdict with drifted=True to /alignment/check, which
    # flows into the next /check call automatically.
    result = executor.invoke(
        {"input": "Summarise our latest customer-feedback survey for the team meeting."}
    )
    print()
    print("final answer:", result.get("output", "")[:200])
    print()
    print("last alignment verdict:", callback.last_result)


if __name__ == "__main__":
    main()
