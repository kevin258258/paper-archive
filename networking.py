"""Use verified TLS, including a bundled CA set for frozen desktop backends."""
import ssl
import certifi


def tls_context():
    context = ssl.create_default_context()
    context.load_verify_locations(cafile=certifi.where())
    return context
