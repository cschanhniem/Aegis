# typed: true
# frozen_string_literal: true

# AEGIS CLI — Homebrew Formula
#
# This file is meant to live in a separate `homebrew-aegis` tap repo as
# `Formula/aegis.rb`. We keep it in-tree so PRs to AEGIS can update the
# formula in lockstep with releases; the release CI copies it to the
# tap repo.
#
# Install once the tap repo exists:
#
#   brew tap Justin0504/aegis
#   brew install aegis
#
# Provides three binaries:
#   agentguard         — main CLI (scan, inject, status, traces, …)
#   aegis-mcp-proxy    — MCP server proxy for Claude Desktop
#   aegis-http-proxy   — HTTP proxy for OpenAI-compatible SDKs

class Aegis < Formula
  desc "Runtime safety layer for AI agents — scan, instrument, audit"
  homepage "https://aegis.dev"
  license "MIT"
  version "1.0.0"

  # Source tarball from the GitHub release. The release workflow attaches
  # a `agentguard-cli-${VERSION}.tar.gz` containing only packages/cli/dist
  # + package.json, so we don't ship the entire monorepo (~150MB).
  url "https://github.com/Justin0504/Aegis/releases/download/v#{version}/agentguard-cli-#{version}.tar.gz"
  # sha256 set by the release workflow; left blank for the initial tap.
  sha256 ""

  depends_on "node@20"

  def install
    # Trim to runtime files only.
    libexec.install Dir["*"]
    cd libexec do
      system "npm", "install", "--production", "--ignore-scripts", "--no-audit", "--no-fund"
    end

    # Wrap each bin so they pick up the right node + library path.
    %w[agentguard aegis-mcp-proxy aegis-http-proxy].each do |b|
      bin_target =
        case b
        when "agentguard"       then "dist/index.js"
        when "aegis-mcp-proxy"  then "dist/mcp-proxy.js"
        when "aegis-http-proxy" then "dist/http-proxy.js"
        end
      (bin/b).write <<~SH
        #!/usr/bin/env bash
        exec "#{Formula["node@20"].opt_bin}/node" "#{libexec}/#{bin_target}" "$@"
      SH
      (bin/b).chmod 0755
    end
  end

  def caveats
    <<~EOS
      AEGIS CLI is now installed. Try:

        agentguard scan ~/your-agent-repo
        agentguard inject ~/your-agent-repo
        agentguard status
        agentguard traces --tail

      To run the gateway + cockpit locally as well:

        curl -fsSL https://raw.githubusercontent.com/Justin0504/Aegis/main/scripts/install.sh | bash

      Or in Kubernetes:

        helm repo add aegis https://justin0504.github.io/Aegis/charts
        helm install aegis aegis/aegis -n aegis --create-namespace
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/agentguard --version")
  end
end
