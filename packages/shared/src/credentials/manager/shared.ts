

export interface LlmCredentialBinding {
    /** Exact encrypted-vault slot used by the selected auth mechanism. */
    slot: 'llm_api_key' | 'llm_oauth' | 'llm_iam' | 'llm_service_account' | 'none';
    /** Host-minted generation. It never contains or hashes credential material. */
    bindingId: string;
}
