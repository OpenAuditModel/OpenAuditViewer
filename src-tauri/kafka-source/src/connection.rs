//! Where to connect, and how.
use rdkafka::config::ClientConfig;
use serde::{Deserialize, Serialize};

use crate::{roots, CLIENT_ID, GROUP_ID};

/// The most bootstrap servers a connection names. A cluster is found through
/// any one of them; a longer list is a mistake, not a larger cluster.
pub const MAX_BOOTSTRAP_SERVERS: usize = 16;

/// Largest custom CA bundle accepted, in bytes.
pub const MAX_CA_PEM_BYTES: usize = 256 * 1024;

/// How the connection is protected.
///
/// `SASL_PLAINTEXT` is deliberately absent: it sends a credential — in the
/// clear, for PLAIN — over a connection nobody can vouch for. A broker that
/// asks for a password is reached over TLS or not at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Security {
    /// No TLS and no authentication. Audit events cross the network in the
    /// clear; the viewer says so when this is chosen.
    Plaintext,
    /// TLS, no authentication.
    Tls,
    /// TLS, then SASL.
    SaslTls,
}

/// The SASL mechanisms supported. GSSAPI and OAUTHBEARER are not.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SaslMechanism {
    #[serde(rename = "PLAIN")]
    Plain,
    #[serde(rename = "SCRAM-SHA-256")]
    ScramSha256,
    #[serde(rename = "SCRAM-SHA-512")]
    ScramSha512,
}

impl SaslMechanism {
    pub fn as_str(self) -> &'static str {
        match self {
            SaslMechanism::Plain => "PLAIN",
            SaslMechanism::ScramSha256 => "SCRAM-SHA-256",
            SaslMechanism::ScramSha512 => "SCRAM-SHA-512",
        }
    }
}

/// A SASL identity. `Debug` never prints the password.
#[derive(Clone)]
pub struct Sasl {
    pub mechanism: SaslMechanism,
    pub username: String,
    pub password: String,
}

impl std::fmt::Debug for Sasl {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Sasl")
            .field("mechanism", &self.mechanism)
            .field("username", &self.username)
            .field("password", &"<not shown>")
            .finish()
    }
}

/// Everything needed to reach a cluster.
#[derive(Clone, Debug)]
pub struct Connection {
    pub bootstrap_servers: Vec<String>,
    pub security: Security,
    /// Present exactly when `security` is [`Security::SaslTls`].
    pub sasl: Option<Sasl>,
    /// The CA certificates to trust instead of the public root set, as PEM.
    pub ca_pem: Option<String>,
}

/// Why a connection description cannot be used. Every message is written
/// here and names no secret.
#[derive(Debug, PartialEq, Eq)]
pub struct ConnectionError(pub String);

impl std::fmt::Display for ConnectionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ConnectionError {}

fn refuse<T>(message: impl Into<String>) -> Result<T, ConnectionError> {
    Err(ConnectionError(message.into()))
}

/// Checks one `host:port`. A host is a DNS name, an IPv4 address, or an IPv6
/// address in brackets; anything with a scheme, a path, a comma or white
/// space is refused rather than passed to librdkafka to interpret.
pub fn validate_server(server: &str) -> Result<(), ConnectionError> {
    let port = if let Some(rest) = server.strip_prefix('[') {
        let Some((address, port)) = rest.split_once("]:") else {
            return refuse(format!("\"{server}\" is not host:port"));
        };
        let valid_address = !address.is_empty()
            && address.chars().all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.');
        if !valid_address {
            return refuse(format!("\"{server}\" does not hold an IPv6 address in brackets"));
        }
        port
    } else {
        let Some((host, port)) = server.rsplit_once(':') else {
            return refuse(format!("\"{server}\" has no port; write it as host:port"));
        };
        let valid_host = !host.is_empty()
            && host.len() <= 253
            && host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_');
        if !valid_host {
            return refuse(format!("\"{server}\" does not start with a host name or address"));
        }
        port
    };
    match port.parse::<u16>() {
        Ok(port) if port > 0 => Ok(()),
        _ => refuse(format!("\"{server}\" does not end with a port between 1 and 65535")),
    }
}

/// Checks a topic name against the characters Kafka allows.
pub fn validate_topic(topic: &str) -> Result<(), ConnectionError> {
    let legal = !topic.is_empty()
        && topic.len() <= 249
        && topic != "."
        && topic != ".."
        && topic
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-');
    if legal {
        Ok(())
    } else {
        refuse(format!(
            "\"{topic}\" is not a Kafka topic name: 1 to 249 characters from a-z, A-Z, 0-9, '.', '_' and '-'"
        ))
    }
}

/// Counts the certificates in a PEM bundle, refusing one with none.
pub fn count_pem_certificates(pem: &str) -> Result<usize, ConnectionError> {
    if pem.len() > MAX_CA_PEM_BYTES {
        return refuse(format!(
            "the CA file is {} bytes, above the {MAX_CA_PEM_BYTES} byte limit",
            pem.len()
        ));
    }
    if pem.contains("PRIVATE KEY-----") {
        return refuse("the CA file holds a private key; choose the CA certificate only");
    }
    let count = pem.matches("-----BEGIN CERTIFICATE-----").count();
    if count == 0 {
        return refuse("the CA file holds no PEM certificate");
    }
    Ok(count)
}

impl Connection {
    /// Refuses a description that is incomplete or contradicts itself.
    pub fn validate(&self) -> Result<(), ConnectionError> {
        if self.bootstrap_servers.is_empty() {
            return refuse("name at least one bootstrap server");
        }
        if self.bootstrap_servers.len() > MAX_BOOTSTRAP_SERVERS {
            return refuse(format!(
                "{} bootstrap servers named; one is enough to find a cluster, and at most {MAX_BOOTSTRAP_SERVERS} are accepted",
                self.bootstrap_servers.len()
            ));
        }
        for server in &self.bootstrap_servers {
            validate_server(server)?;
        }
        match (&self.security, &self.sasl) {
            (Security::SaslTls, None) => return refuse("SASL needs a user name and a password"),
            (Security::Plaintext | Security::Tls, Some(_)) => {
                return refuse("a password is only ever sent over TLS with SASL")
            }
            (Security::SaslTls, Some(sasl)) => {
                if sasl.username.is_empty() {
                    return refuse("SASL needs a user name");
                }
                if sasl.password.is_empty() {
                    return refuse("SASL needs a password");
                }
            }
            _ => {}
        }
        if let Some(pem) = &self.ca_pem {
            if self.security == Security::Plaintext {
                return refuse("a CA certificate means nothing without TLS");
            }
            count_pem_certificates(pem)?;
        }
        Ok(())
    }

    /// The librdkafka configuration for a read-only consumer on this connection.
    pub fn client_config(&self) -> Result<ClientConfig, ConnectionError> {
        self.validate()?;
        let mut config = ClientConfig::new();
        config
            .set("bootstrap.servers", self.bootstrap_servers.join(","))
            .set("client.id", CLIENT_ID)
            // Required: librdkafka's assign works only through a group
            // handle. The group is never joined and holds no offset.
            .set("group.id", GROUP_ID)
            // Read-only by construction: nothing is committed, nothing is
            // stored for a later commit, and asking for a topic that does not
            // exist does not create it.
            .set("enable.auto.commit", "false")
            .set("enable.auto.offset.store", "false")
            .set("allow.auto.create.topics", "false")
            .set("enable.partition.eof", "true")
            .set("auto.offset.reset", "earliest")
            .set("isolation.level", "read_committed")
            .set("socket.timeout.ms", "15000")
            .set("session.timeout.ms", "10000")
            .set("log.connection.close", "false");
        match self.security {
            Security::Plaintext => {
                config.set("security.protocol", "plaintext");
            }
            Security::Tls | Security::SaslTls => {
                config
                    .set(
                        "security.protocol",
                        if self.security == Security::Tls { "ssl" } else { "sasl_ssl" },
                    )
                    .set("enable.ssl.certificate.verification", "true")
                    .set("ssl.endpoint.identification.algorithm", "https")
                    .set(
                        "ssl.ca.pem",
                        self.ca_pem.clone().unwrap_or_else(roots::mozilla_roots_pem),
                    );
            }
        }
        if let Some(sasl) = &self.sasl {
            config
                .set("sasl.mechanism", sasl.mechanism.as_str())
                .set("sasl.username", &sasl.username)
                .set("sasl.password", &sasl.password);
        }
        Ok(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plaintext(servers: &[&str]) -> Connection {
        Connection {
            bootstrap_servers: servers.iter().map(|s| (*s).to_owned()).collect(),
            security: Security::Plaintext,
            sasl: None,
            ca_pem: None,
        }
    }

    #[test]
    fn a_server_is_host_and_port_and_nothing_else() {
        for good in ["kafka:9092", "broker-1.example.com:9094", "10.0.0.7:9092", "[::1]:9092"] {
            assert_eq!(validate_server(good), Ok(()), "{good}");
        }
        for bad in [
            "kafka",
            "kafka:",
            "kafka:0",
            "kafka:70000",
            ":9092",
            "PLAINTEXT://kafka:9092",
            "kafka:9092/path",
            "kafka 1:9092",
            "a,b:9092",
            "[::1]",
            "[]:9092",
        ] {
            assert!(validate_server(bad).is_err(), "{bad} was accepted");
        }
    }

    #[test]
    fn a_topic_name_is_what_kafka_allows() {
        assert!(validate_topic("audit.events-v1_eu").is_ok());
        for bad in ["", ".", "..", "audit events", "audit/events", &"a".repeat(250)] {
            assert!(validate_topic(bad).is_err(), "{bad} was accepted");
        }
    }

    #[test]
    fn a_password_is_never_sent_without_tls() {
        let mut connection = plaintext(&["kafka:9092"]);
        connection.sasl = Some(Sasl {
            mechanism: SaslMechanism::Plain,
            username: "reader".into(),
            password: "secret".into(),
        });
        assert!(connection.validate().is_err());
        connection.security = Security::Tls;
        assert!(connection.validate().is_err(), "TLS without SASL carries no password");
        connection.security = Security::SaslTls;
        assert!(connection.validate().is_ok());
    }

    #[test]
    fn nothing_is_committed_and_no_topic_is_created() {
        let config = plaintext(&["kafka:9092"]).client_config().expect("valid");
        assert_eq!(config.get("enable.auto.commit"), Some("false"));
        assert_eq!(config.get("enable.auto.offset.store"), Some("false"));
        assert_eq!(config.get("allow.auto.create.topics"), Some("false"));
        assert_eq!(config.get("group.id"), Some(GROUP_ID));
    }

    #[test]
    fn tls_verifies_the_broker_against_the_public_roots_unless_told_otherwise() {
        let mut connection = plaintext(&["kafka:9094"]);
        connection.security = Security::Tls;
        let config = connection.client_config().expect("valid");
        assert_eq!(config.get("enable.ssl.certificate.verification"), Some("true"));
        assert_eq!(config.get("ssl.endpoint.identification.algorithm"), Some("https"));
        let roots = config.get("ssl.ca.pem").expect("roots set");
        assert!(roots.matches("-----BEGIN CERTIFICATE-----").count() > 100);

        let custom = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
        connection.ca_pem = Some(custom.to_owned());
        let config = connection.client_config().expect("valid");
        assert_eq!(config.get("ssl.ca.pem"), Some(custom), "a custom CA replaces the public roots");
    }

    #[test]
    fn a_ca_file_with_a_private_key_in_it_is_refused() {
        assert!(count_pem_certificates(
            "-----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY-----\n-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"
        )
        .is_err());
        assert!(count_pem_certificates("not pem").is_err());
    }

    #[test]
    fn debug_output_never_shows_the_password() {
        let sasl = Sasl {
            mechanism: SaslMechanism::ScramSha512,
            username: "reader".into(),
            password: "hunter2".into(),
        };
        let shown = format!("{sasl:?}");
        assert!(!shown.contains("hunter2"));
        assert!(shown.contains("reader"));
    }
}
