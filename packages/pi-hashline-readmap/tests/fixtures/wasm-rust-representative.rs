// Representative Rust module: a small service/repository with traits,
// generics, async methods, nested modules, and assorted symbols.

use std::collections::HashMap;
use std::fmt::Debug;
use std::sync::Arc;

pub const DEFAULT_PAGE_SIZE: usize = 25;
pub const MAX_PAGE_SIZE: usize = 100;

pub type UserId = u64;

#[derive(Debug, Clone)]
pub struct User {
    pub id: UserId,
    pub name: String,
    pub email: String,
    pub active: bool,
}

#[derive(Debug, Clone)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

#[derive(Debug)]
pub enum RepoError {
    NotFound(UserId),
    Conflict(String),
    Backend(String),
}

pub trait UserRepository: Send + Sync {
    fn find(&self, id: UserId) -> Result<User, RepoError>;
    fn list(&self, cursor: Option<String>, limit: usize) -> Result<Page<User>, RepoError>;
    fn upsert(&self, user: User) -> Result<User, RepoError>;
    fn delete(&self, id: UserId) -> Result<(), RepoError>;
}

pub struct InMemoryUserRepository {
    users: HashMap<UserId, User>,
}

impl InMemoryUserRepository {
    pub fn new() -> Self {
        Self { users: HashMap::new() }
    }

    pub fn with_seed(seed: Vec<User>) -> Self {
        let mut repo = Self::new();
        for user in seed {
            repo.users.insert(user.id, user);
        }
        repo
    }

    fn next_id(&self) -> UserId {
        self.users.keys().max().copied().unwrap_or(0) + 1
    }
}

impl UserRepository for InMemoryUserRepository {
    fn find(&self, id: UserId) -> Result<User, RepoError> {
        self.users
            .get(&id)
            .cloned()
            .ok_or(RepoError::NotFound(id))
    }

    fn list(&self, _cursor: Option<String>, limit: usize) -> Result<Page<User>, RepoError> {
        let items: Vec<User> = self.users.values().take(limit).cloned().collect();
        Ok(Page { items, next_cursor: None })
    }

    fn upsert(&self, mut user: User) -> Result<User, RepoError> {
        if user.id == 0 {
            user.id = self.next_id();
        }
        Ok(user)
    }

    fn delete(&self, id: UserId) -> Result<(), RepoError> {
        if self.users.contains_key(&id) {
            Ok(())
        } else {
            Err(RepoError::NotFound(id))
        }
    }
}

pub struct UserService<R: UserRepository> {
    repo: Arc<R>,
}

impl<R: UserRepository> UserService<R> {
    pub fn new(repo: Arc<R>) -> Self {
        Self { repo }
    }

    pub async fn get_user(&self, id: UserId) -> Result<User, RepoError> {
        self.repo.find(id)
    }

    pub async fn list_users(&self, cursor: Option<String>, limit: usize) -> Result<Page<User>, RepoError> {
        let capped = limit.min(MAX_PAGE_SIZE).max(1);
        self.repo.list(cursor, capped)
    }

    pub async fn register(&self, name: String, email: String) -> Result<User, RepoError> {
        let user = User { id: 0, name, email, active: true };
        self.repo.upsert(user)
    }

    pub async fn deactivate(&self, id: UserId) -> Result<User, RepoError> {
        let mut user = self.repo.find(id)?;
        user.active = false;
        self.repo.upsert(user)
    }
}

pub mod notifications {
    use super::{User, UserId};

    pub trait Notifier {
        fn notify(&self, user: &User, message: &str);
    }

    pub struct LogNotifier;

    impl Notifier for LogNotifier {
        fn notify(&self, user: &User, message: &str) {
            println!("[notify {}] {}: {}", user.id, user.name, message);
        }
    }

    pub fn welcome_message(user_id: UserId) -> String {
        format!("Welcome, user #{}!", user_id)
    }
}

pub mod utils {
    pub fn clamp<T: PartialOrd>(value: T, lo: T, hi: T) -> T {
        if value < lo { lo } else if value > hi { hi } else { value }
    }

    pub fn first_or_default<T: Default + Clone>(items: &[T]) -> T {
        items.first().cloned().unwrap_or_default()
    }
}

pub fn paginate<T: Clone>(items: &[T], page: usize, page_size: usize) -> Page<T> {
    let start = page.saturating_mul(page_size);
    let end = (start + page_size).min(items.len());
    let slice = if start < items.len() {
        items[start..end].to_vec()
    } else {
        Vec::new()
    };
    Page { items: slice, next_cursor: None }
}
