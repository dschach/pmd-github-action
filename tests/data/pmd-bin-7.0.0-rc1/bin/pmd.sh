#!/usr/bin/env bash

echo "Running PMD 7.0.0-rc1 with: $@"

echo '{
  "runs": [
    {
      "tool": {
        "driver": {
          "name": "PMD",
          "version": "7.0.0-rc1"
        }
      }
    }
  ]
}' > pmd-report.sarif

