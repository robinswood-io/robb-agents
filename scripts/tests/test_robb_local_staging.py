"""Native installer scenarios, grouped by transaction phase."""

import unittest

from .robb_local_staging_activation_cases import LocalStagingActivationTests
from .robb_local_staging_checkpoints_cases import LocalStagingCheckpointsTests
from .robb_local_staging_preflight_cases import LocalStagingTests
from .robb_local_staging_recovery_cases import LocalStagingRecoveryTests

if __name__ == "__main__":
    _ = unittest.main()

__all__ = [
    'LocalStagingActivationTests', 'LocalStagingCheckpointsTests', 'LocalStagingRecoveryTests',
    'LocalStagingTests',
]
