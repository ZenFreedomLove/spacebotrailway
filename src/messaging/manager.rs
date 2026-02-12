//! MessagingManager: Fan-in and routing for all adapters.

use crate::messaging::traits::{HistoryMessage, InboundStream, Messaging, MessagingDyn};
use crate::{InboundMessage, OutboundResponse, StatusUpdate};

use anyhow::Context as _;
use std::collections::HashMap;
use std::sync::Arc;

/// Manages all messaging adapters.
pub struct MessagingManager {
    adapters: HashMap<String, Arc<dyn MessagingDyn>>,
}

impl MessagingManager {
    pub fn new() -> Self {
        Self {
            adapters: HashMap::new(),
        }
    }

    /// Register an adapter.
    pub fn register(&mut self, adapter: impl Messaging) {
        let name = adapter.name().to_string();
        tracing::info!(adapter = %name, "registered messaging adapter");
        self.adapters.insert(name, Arc::new(adapter));
    }

    /// Start all registered adapters and merge their inbound streams.
    pub async fn start(&self) -> crate::Result<InboundStream> {
        let streams = futures::future::try_join_all(
            self.adapters.values().map(|adapter| adapter.start()),
        )
        .await?;

        Ok(Box::pin(futures::stream::select_all(streams)))
    }

    /// Route a response back to the correct adapter based on message source.
    pub async fn respond(
        &self,
        message: &InboundMessage,
        response: OutboundResponse,
    ) -> crate::Result<()> {
        let adapter = self
            .adapters
            .get(&message.source)
            .with_context(|| format!("no messaging adapter named '{}'", message.source))?;
        adapter.respond(message, response).await
    }

    /// Route a status update to the correct adapter.
    pub async fn send_status(
        &self,
        message: &InboundMessage,
        status: StatusUpdate,
    ) -> crate::Result<()> {
        let adapter = self
            .adapters
            .get(&message.source)
            .with_context(|| format!("no messaging adapter named '{}'", message.source))?;
        adapter.send_status(message, status).await
    }

    /// Send a proactive message through a specific adapter.
    pub async fn broadcast(
        &self,
        adapter_name: &str,
        target: &str,
        response: OutboundResponse,
    ) -> crate::Result<()> {
        let adapter = self
            .adapters
            .get(adapter_name)
            .with_context(|| format!("no messaging adapter named '{adapter_name}'"))?;
        adapter.broadcast(target, response).await
    }

    /// Fetch recent message history from the platform for context backfill.
    pub async fn fetch_history(
        &self,
        message: &InboundMessage,
        limit: usize,
    ) -> crate::Result<Vec<HistoryMessage>> {
        let adapter = self
            .adapters
            .get(&message.source)
            .with_context(|| format!("no messaging adapter named '{}'", message.source))?;
        adapter.fetch_history(message, limit).await
    }

    /// Shut down all adapters gracefully.
    pub async fn shutdown(&self) {
        for (name, adapter) in &self.adapters {
            if let Err(error) = adapter.shutdown().await {
                tracing::warn!(adapter = %name, %error, "failed to shut down adapter");
            }
        }
    }
}

impl Default for MessagingManager {
    fn default() -> Self {
        Self::new()
    }
}
