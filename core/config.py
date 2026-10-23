from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


ROOT = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=str(ROOT / ".env"), extra="ignore")

    database_path: Path = ROOT / "data" / "app.db"
    raster_dir: Path = ROOT / "data" / "rasters"
    model_path: Path = ROOT / "data" / "models" / "burn_lgbm.txt"
    enable_live_gee: bool = False
    gee_service_account_json: str = ""
    gee_project: str = ""
    rakhine_validated: bool = True
    # LightGBM operating point from the validation split (ADS paper, §V).
    default_burn_threshold: float = 0.91
    default_z_threshold: float = 3.0
    default_baseline_months: int = 12
    max_aoi_km2: float = 2_500.0
    # myACLED login for prior-report search. SecretStr keeps it out of reprs and logs.
    acled_username: str = ""
    acled_password: SecretStr = SecretStr("")
    # Fictional ACLED-shaped records instead of the API, for building without access.
    acled_sample: bool = False
    # NASA FIRMS key for fire detections (free: https://firms.modaps.eosdis.nasa.gov/api/map_key/).
    firms_map_key: SecretStr = SecretStr("")


settings = Settings()
