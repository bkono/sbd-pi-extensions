// Nested modules, traits, and impl blocks.

pub mod outer {
    pub mod inner {
        pub struct Widget {
            pub id: u32,
            pub name: String,
        }

        impl Widget {
            pub fn new(id: u32, name: String) -> Self {
                Self { id, name }
            }

            pub fn rename(&mut self, name: String) {
                self.name = name;
            }
        }

        pub trait Describe {
            fn describe(&self) -> String;
        }

        impl Describe for Widget {
            fn describe(&self) -> String {
                format!("Widget({}, {})", self.id, self.name)
            }
        }
    }

    pub fn make_widget(id: u32) -> inner::Widget {
        inner::Widget::new(id, "default".to_string())
    }
}

pub trait Counter {
    fn count(&self) -> usize;
}

pub struct ZeroCounter;

impl Counter for ZeroCounter {
    fn count(&self) -> usize {
        0
    }
}
