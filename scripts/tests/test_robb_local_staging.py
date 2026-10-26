"""Native installer scenarios, grouped by transaction phase."""

import unittest

from .robb_local_staging_preflight_cases import LocalStagingTests
from .robb_local_staging_activation_cases import LocalStagingActivationTests
from .robb_local_staging_recovery_cases import LocalStagingRecoveryTests
from .robb_local_staging_checkpoints_cases import LocalStagingCheckpointsTests


if __name__ == "__main__":
    unittest.main()
