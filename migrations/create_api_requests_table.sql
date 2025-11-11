-- Create sb_api_requests table for logging quote and unwrap API requests
-- This table stores both quote and unwrap requests with a request_type discriminator

CREATE TABLE IF NOT EXISTS sb_api_requests (
  -- Primary key
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Request type discriminator
  request_type TEXT NOT NULL CHECK (request_type IN ('quote', 'unwrap')),
  
  -- Common fields
  address TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  group_id TEXT,
  slippage_tolerance NUMERIC,
  network_fee_estimate TEXT,
  error TEXT,
  
  -- Quote-specific fields
  input_token TEXT,
  output_token TEXT,
  input_amount TEXT,
  output_amount TEXT,
  minimum_output_amount TEXT,
  rate NUMERIC,
  price_impact NUMERIC,
  route_type TEXT CHECK (route_type IN ('direct', 'multi-hop')),
  pool_id TEXT,
  route JSONB,
  
  -- Unwrap-specific fields
  items JSONB
);

-- Create indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_sb_api_requests_group_id ON sb_api_requests(group_id);
CREATE INDEX IF NOT EXISTS idx_sb_api_requests_created_at ON sb_api_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_sb_api_requests_request_type ON sb_api_requests(request_type);
CREATE INDEX IF NOT EXISTS idx_sb_api_requests_address ON sb_api_requests(address);

-- Add constraint: quote requests must have input_token, output_token, and input_amount
ALTER TABLE sb_api_requests ADD CONSTRAINT chk_quote_required_fields 
  CHECK (
    request_type != 'quote' OR 
    (input_token IS NOT NULL AND output_token IS NOT NULL AND input_amount IS NOT NULL)
  );

-- Add constraint: unwrap requests must have items
ALTER TABLE sb_api_requests ADD CONSTRAINT chk_unwrap_required_fields
  CHECK (
    request_type != 'unwrap' OR 
    items IS NOT NULL
  );

