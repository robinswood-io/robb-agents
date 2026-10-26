"""Native installer scenarios, grouped by transaction phase."""

import unittest

from .install_staging_retention_publication_cases import InstallStagingRetentionTests
from .install_staging_retention_recovery_cases import InstallStagingRetentionRecoveryTests


if __name__ == "__main__":
    unittest.main()
